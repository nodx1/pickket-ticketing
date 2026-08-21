"""재판매 티켓 상태 재검증 (M-2) — Critical idx3 회귀 테스트.

환불(CANCELLED)·체크인(USED)된 티켓은 소유자가 그대로여도 판매 불가:
- 매칭 시점: 잔존 ACTIVE 리스팅을 매칭에서 제거(리스팅 CANCELLED)
- 원클릭: PG 청구 *전* 거부 (환불 불필요)
- confirm: PG paid 확인 후 거부 → 기존 거부-환불 경로로 자동 PG 환불
- _apply_resale_ownership_transfer: 최후 심층 방어선
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.models.order import OrderStatus, OrderType
from app.models.payment_attempt import PaymentAttempt
from app.models.resale import (
    ResaleBuyOrderModel,
    ResaleBuyOrderStatus,
    ResaleListingModel,
    ResaleListingStatus,
)
from app.models.ticket import TicketStatus
from app.services.payment_service import (
    PaymentConfirmationRejected,
    PaymentService,
)

from .test_billing_one_click import _create_one_click_bundle
from app.core.config import settings


@pytest.fixture(autouse=True)
def _pin_toss_default_provider(monkeypatch):
    """이 모듈은 **토스 게이트웨이 시맨틱** 기준으로 작성됐다(예: authorized 상태 전이).

    2026-07-28 대표 결정으로 `settings.PAYMENT_PROVIDER` 기본값이 toss → nicepay 로 바뀌면서
    `get_payment_gateway()` 무인자 호출이 NicepayGateway 를 돌려주게 됐고, 나이스 mock 은
    다른 상태(payment_required)를 내므로 이 테스트들이 깨졌다.

    테스트 의도가 "토스 경로"이므로 provider 를 **명시 고정**한다. 암묵 기본값에 기대던 것을
    드러낸 것이지 동작을 되돌린 게 아니다.
    ⚠️ 나이스 구형 경로의 동등 커버리지는 test_nicepay_* 가 담당한다.
    """
    monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "toss", raising=False)


class _CountingVoidGateway:
    """gateway.void_authorization 호출을 세는 프록시 (test_payment_confirm_rejection 패턴)."""

    def __init__(self, inner, *, voided: bool = True):
        self._inner = inner
        self._voided = voided
        self.void_calls = 0

    def __getattr__(self, name):
        return getattr(self._inner, name)

    async def void_authorization(self, *, payment_id, reason, amount=None):
        self.void_calls += 1
        result = await self._inner.void_authorization(payment_id=payment_id, reason=reason)
        result.voided = self._voided
        return result


# ── 원클릭 경로: PG 청구 전 거부 ────────────────────────────────────


@pytest.mark.parametrize(
    "bad_status", [TicketStatus.CANCELLED, TicketStatus.USED, TicketStatus.TRANSFERRED]
)
@pytest.mark.asyncio
async def test_one_click_rejects_unsellable_resale_ticket_before_charge(
    db_session, bad_status
):
    """환불/체크인/양도된 티켓의 재판매 주문 → 청구 시도 없이 거부."""
    bundle = await _create_one_click_bundle(db_session, order_type=OrderType.RESALE_BUY)
    ticket = bundle["resale_ticket"]
    ticket.status = bad_status
    await db_session.flush()

    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="판매 가능한 상태가 아닙니다"):
        await svc.process_one_click_payment(
            user_id=bundle["buyer"].id,
            order_id=bundle["order"].id,
            billing_key_id=bundle["billing_key"].id,
            idempotency_key=f"resale-guard-{bad_status.value}",
        )

    # PG 청구 시도 자체가 없어야 함 (PaymentAttempt 0건)
    attempts = (
        await db_session.execute(
            select(PaymentAttempt).where(PaymentAttempt.order_id == bundle["order"].id)
        )
    ).scalars().all()
    assert attempts == []

    # 주문/리스팅/소유권 모두 불변
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.PAYMENT_REQUIRED
    await db_session.refresh(bundle["listing"])
    assert bundle["listing"].status == ResaleListingStatus.MATCHED
    await db_session.refresh(ticket)
    assert ticket.current_owner_id == bundle["seller"].id
    assert (ticket.transfer_count or 0) == 0


# ── confirm 경로: PG paid 확인 후 거부 + 자동 환불 ──────────────────


@pytest.mark.asyncio
async def test_confirm_rejects_unsellable_resale_ticket_with_auto_refund(db_session):
    """환불된(CANCELLED) 티켓의 재판매 confirm → 자동 PG 환불 + 거부 + 주문 CANCELLED."""
    bundle = await _create_one_click_bundle(db_session, order_type=OrderType.RESALE_BUY)
    order = bundle["order"]
    ticket = bundle["resale_ticket"]
    ticket.status = TicketStatus.CANCELLED  # 매칭~결제 사이 원 주문 환불 시나리오
    order.payment_id = "pay_resale_guard_1"
    await db_session.flush()

    svc = PaymentService(db_session)
    counting = _CountingVoidGateway(svc.gateway)
    svc.gateway = counting

    with pytest.raises(PaymentConfirmationRejected, match="no longer sellable") as ei:
        await svc.confirm_payment(
            order.id,
            pg_txn_id="txn_resale_guard_1",
            payment_id="pay_resale_guard_1",
            amount=float(order.total_amount),
        )
    assert ei.value.refunded is True
    assert counting.void_calls == 1  # 기존 거부-환불 경로(_refund_rejected_confirmation)

    await db_session.flush()
    await db_session.refresh(order)
    assert order.status == OrderStatus.CANCELLED
    meta = order.payment_metadata["confirm_rejected_refund"]
    assert meta["refunded"] is True
    assert meta["reason"].startswith("resale_ticket_not_sellable")

    # 소유권 이전·리스팅 SOLD 전이가 일어나지 않아야 함
    await db_session.refresh(ticket)
    assert ticket.current_owner_id == bundle["seller"].id
    assert (ticket.transfer_count or 0) == 0
    await db_session.refresh(bundle["listing"])
    assert bundle["listing"].status != ResaleListingStatus.SOLD


@pytest.mark.asyncio
async def test_confirm_used_ticket_rejected(db_session):
    """체크인(USED)된 티켓도 동일하게 confirm 거부."""
    bundle = await _create_one_click_bundle(db_session, order_type=OrderType.RESALE_BUY)
    order = bundle["order"]
    bundle["resale_ticket"].status = TicketStatus.USED
    order.payment_id = "pay_resale_guard_2"
    await db_session.flush()

    svc = PaymentService(db_session)
    counting = _CountingVoidGateway(svc.gateway)
    svc.gateway = counting

    with pytest.raises(PaymentConfirmationRejected) as ei:
        await svc.confirm_payment(
            order.id,
            pg_txn_id="txn_resale_guard_2",
            payment_id="pay_resale_guard_2",
            amount=float(order.total_amount),
        )
    assert ei.value.refunded is True
    await db_session.flush()
    await db_session.refresh(order)
    assert "resale_ticket_not_sellable(status=used)" in (
        order.payment_metadata["confirm_rejected_refund"]["reason"]
    )


# ── 정상 케이스 회귀: ACTIVE 티켓은 그대로 판매됨 ───────────────────


@pytest.mark.asyncio
async def test_confirm_active_resale_ticket_still_transfers(db_session):
    """ACTIVE 티켓의 재판매 confirm은 기존대로 소유권 이전 성공 (회귀 가드)."""
    bundle = await _create_one_click_bundle(db_session, order_type=OrderType.RESALE_BUY)
    order = bundle["order"]
    order.payment_id = "pay_resale_ok_1"
    await db_session.flush()

    svc = PaymentService(db_session)
    resp = await svc.confirm_payment(
        order.id,
        pg_txn_id="txn_resale_ok_1",
        payment_id="pay_resale_ok_1",
        amount=float(order.total_amount),
    )
    assert resp.status == "confirmed"
    await db_session.refresh(bundle["resale_ticket"])
    assert bundle["resale_ticket"].current_owner_id == bundle["buyer"].id
    await db_session.refresh(bundle["listing"])
    assert bundle["listing"].status == ResaleListingStatus.SOLD


# ── 심층 방어선: _apply_resale_ownership_transfer 직접 검증 ─────────


@pytest.mark.asyncio
async def test_ownership_transfer_helper_refuses_unsellable_ticket(db_session):
    """검증 누락 경로가 새로 생겨도 이전 헬퍼 자체가 최종 차단한다."""
    bundle = await _create_one_click_bundle(db_session, order_type=OrderType.RESALE_BUY)
    bundle["resale_ticket"].status = TicketStatus.CANCELLED
    await db_session.flush()

    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="not sellable"):
        await svc._apply_resale_ownership_transfer(bundle["order"])


# ── 매칭 시점: 잔존 리스팅 제거 ─────────────────────────────────────


@pytest.mark.asyncio
async def test_matching_skips_listing_of_unsellable_ticket(db_session):
    """티켓이 CANCELLED인데 리스팅이 ACTIVE로 잔존 → 매칭 제외 + 리스팅 CANCELLED."""
    from app.services.resale_service import ResaleService

    bundle = await _create_one_click_bundle(db_session, order_type=OrderType.RESALE_BUY)
    ticket = bundle["resale_ticket"]
    listing = bundle["listing"]

    # 시나리오 재현: 리스팅 ACTIVE 상태에서 원 주문이 환불되어 티켓 CANCELLED
    listing.status = ResaleListingStatus.ACTIVE
    ticket.status = TicketStatus.CANCELLED
    bid = ResaleBuyOrderModel(
        event_id=ticket.event_id,
        tier_id=ticket.tier_id,
        buyer_id=bundle["buyer"].id,
        max_price=float(listing.asking_price) + 10.0,
        status=ResaleBuyOrderStatus.ACTIVE,
    )
    db_session.add(bid)
    await db_session.flush()

    svc = ResaleService(db_session)
    trades = await svc.match_and_execute(event_id=ticket.event_id, tier_id=ticket.tier_id)

    assert trades == []  # 거래 미체결
    await db_session.refresh(listing)
    assert listing.status == ResaleListingStatus.CANCELLED  # 잔존 리스팅 정리
    await db_session.refresh(bid)
    assert bid.status == ResaleBuyOrderStatus.ACTIVE  # 구매자 bid는 보존
    await db_session.refresh(ticket)
    assert ticket.current_owner_id == bundle["seller"].id
