"""원클릭(빌링키) 결제 — M-2 이중 청구 방어 + M-3 재판매 소유권 이전 테스트.

Blocker #1: PG 청구가 DB 트랜잭션 내부 + 비결정적 payment_id + idempotency_key 무시
Blocker #5: 원클릭으로 재판매 주문 결제 시 티켓 소유권 이전 누락
"""

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import select

from app.models.billing_key import BillingKey
from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus, OrderType
from app.models.ownership_transfer import OwnershipTransfer, TransferType
from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus
from app.models.resale import ResaleListingModel, ResaleListingStatus
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.services.payment_service import PaymentService
from app.services.toss_gateway import TossGateway
from app.core.config import settings

# 빌링키(원클릭/정기결제)는 토스페이먼츠 전환 범위 밖 — 건별결제만
# (docs/payments/TOSSPAYMENTS-MIGRATION-PLAN.md §0). PAYMENT_PROVIDER=toss 에서는 미지원.
pytestmark = pytest.mark.skipif(
    settings.PAYMENT_PROVIDER != "portone",
    reason="빌링키/원클릭은 토스 전환 범위 밖(건별결제만) — PAYMENT_PROVIDER=portone 에서만 실행",
)


async def _create_one_click_bundle(
    db_session,
    *,
    order_type: OrderType = OrderType.PURCHASE,
    unit_price: float = 50.0,
):
    """Order(PAYMENT_REQUIRED) + 기본 카드(BillingKey) 번들 생성."""
    now = datetime.now(timezone.utc)
    organizer = User(
        email=f"oc_org_{uuid.uuid4().hex[:8]}@test.com",
        hashed_password="x",
        name="Org",
        is_organizer=True,
    )
    buyer = User(
        email=f"oc_buyer_{uuid.uuid4().hex[:8]}@test.com",
        hashed_password="x",
        name="Buyer",
    )
    seller = User(
        email=f"oc_seller_{uuid.uuid4().hex[:8]}@test.com",
        hashed_password="x",
        name="Seller",
    )
    db_session.add_all([organizer, buyer, seller])
    await db_session.flush()

    event = Event(
        organizer_id=organizer.id,
        title="One Click Event",
        slug=f"test-oneclick-{uuid.uuid4().hex[:8]}",
        venue="Arena",
        event_date=now + timedelta(days=30),
        bidding_opens_at=now - timedelta(days=1),
        bidding_closes_at=now + timedelta(days=1),
        total_seats=100,
        min_price=10.0,
        max_price=200.0,
        status=EventStatus.BIDDING_OPEN,
    )
    db_session.add(event)
    await db_session.flush()

    tier = SeatTier(
        event_id=event.id,
        name="VIP",
        capacity=100,
        base_price=unit_price,
        face_price=unit_price,
        sale_mode="fixed_fcfs",
        sold_count=1,
    )
    db_session.add(tier)
    await db_session.flush()

    bk = BillingKey(
        user_id=buyer.id,
        billing_key=f"mock_bk_{uuid.uuid4().hex[:12]}",
        card_type="credit",
        last_four="4242",
        card_brand="VISA",
        is_default=True,
    )
    db_session.add(bk)
    await db_session.flush()

    payment_metadata = None
    listing = None
    resale_ticket = None
    if order_type == OrderType.RESALE_BUY:
        # 판매자 소유 ACTIVE 티켓 + MATCHED 리스팅 (resale_service 매칭 산출물 재현)
        resale_ticket = Ticket(
            event_id=event.id,
            tier_id=tier.id,
            original_owner_id=seller.id,
            current_owner_id=seller.id,
            purchase_price=unit_price,
            sale_mode="fixed_fcfs",
            status=TicketStatus.ACTIVE,
        )
        db_session.add(resale_ticket)
        await db_session.flush()

        listing = ResaleListingModel(
            ticket_id=resale_ticket.id,
            seller_id=seller.id,
            asking_price=unit_price,
            status=ResaleListingStatus.MATCHED,
            seller_receives=unit_price * 0.9,
            platform_fee=unit_price * 0.05,
            artist_royalty=unit_price * 0.05,
        )
        db_session.add(listing)
        await db_session.flush()

        payment_metadata = {
            "resale": {
                "listing_id": str(listing.id),
                "ticket_id": str(resale_ticket.id),
                "seller_id": str(seller.id),
            }
        }

    order = Order(
        user_id=buyer.id,
        event_id=event.id,
        tier_id=tier.id,
        order_type=order_type,
        status=OrderStatus.PAYMENT_REQUIRED,
        quantity=1,
        unit_price=unit_price,
        total_amount=unit_price,
        payment_deadline=now + timedelta(minutes=15),
        payment_currency="KRW",
        payment_metadata=payment_metadata,
    )
    db_session.add(order)
    await db_session.flush()

    if order_type == OrderType.PURCHASE:
        db_session.add(
            Ticket(
                event_id=event.id,
                tier_id=tier.id,
                original_owner_id=buyer.id,
                current_owner_id=buyer.id,
                purchase_price=unit_price,
                sale_mode="fixed_fcfs",
                purchase_order_id=order.id,
                status=TicketStatus.PENDING,
            )
        )
        await db_session.flush()

    return {
        "buyer": buyer,
        "seller": seller,
        "order": order,
        "billing_key": bk,
        "listing": listing,
        "resale_ticket": resale_ticket,
    }


def test_generate_payment_id_is_deterministic():
    """같은 주문+시도 → 항상 같은 paymentId (PortOne측 멱등성 활성화)."""
    order_id = uuid.uuid4()
    first = TossGateway.generate_payment_id(order_id, attempt=1)
    second = TossGateway.generate_payment_id(order_id, attempt=1)
    assert first == second == f"ord_{order_id.hex}_a1"
    # 시도가 다르면 paymentId도 달라야 함
    assert TossGateway.generate_payment_id(order_id, attempt=2) == f"ord_{order_id.hex}_a2"
    # 후방 호환: attempt 미지정 = attempt 1
    assert TossGateway.generate_payment_id(order_id) == first


@pytest.mark.asyncio
async def test_one_click_records_attempt_with_deterministic_payment_id(db_session):
    """트랜잭션 1에서 청구 시도 레코드가 영속화되고 payment_id가 결정론적이어야 한다."""
    bundle = await _create_one_click_bundle(db_session)
    order = bundle["order"]
    svc = PaymentService(db_session)

    resp = await svc.process_one_click_payment(
        user_id=bundle["buyer"].id,
        order_id=order.id,
        billing_key_id=bundle["billing_key"].id,
        idempotency_key="oc-idem-1",
    )
    assert resp.status == "confirmed"

    expected_payment_id = f"ord_{order.id.hex}_a1"
    await db_session.refresh(order)
    assert order.status == OrderStatus.CONFIRMED
    assert order.payment_id == expected_payment_id
    assert order.payment_idempotency_key == "oc-idem-1"

    attempts = (
        await db_session.execute(
            select(PaymentAttempt).where(PaymentAttempt.order_id == order.id)
        )
    ).scalars().all()
    assert len(attempts) == 1
    attempt = attempts[0]
    assert attempt.attempt_no == 1
    assert attempt.payment_id == expected_payment_id
    assert attempt.status == PaymentAttemptStatus.SUCCEEDED
    assert attempt.pg_transaction_id
    assert attempt.idempotency_key == "oc-idem-1"

    # 티켓 활성화 (기존 동작 회귀 확인)
    tickets = (
        await db_session.execute(
            select(Ticket).where(Ticket.purchase_order_id == order.id)
        )
    ).scalars().all()
    assert all(t.status == TicketStatus.ACTIVE for t in tickets)


@pytest.mark.asyncio
async def test_one_click_idempotent_replay_same_key_no_recharge(db_session):
    """같은 idempotency_key 재요청은 기확정 주문을 그대로 반환 — 재청구·에러 금지."""
    bundle = await _create_one_click_bundle(db_session)
    order = bundle["order"]
    svc = PaymentService(db_session)

    first = await svc.process_one_click_payment(
        user_id=bundle["buyer"].id,
        order_id=order.id,
        billing_key_id=bundle["billing_key"].id,
        idempotency_key="oc-idem-replay",
    )
    second = await svc.process_one_click_payment(
        user_id=bundle["buyer"].id,
        order_id=order.id,
        billing_key_id=bundle["billing_key"].id,
        idempotency_key="oc-idem-replay",
    )
    assert second.id == first.id
    assert second.status == "confirmed"

    # 재요청으로 새 청구 시도가 생기면 안 됨
    attempts = (
        await db_session.execute(
            select(PaymentAttempt).where(PaymentAttempt.order_id == order.id)
        )
    ).scalars().all()
    assert len(attempts) == 1

    # 다른(또는 누락된) 키로 기확정 주문 재결제 시도는 거부
    with pytest.raises(ValueError):
        await svc.process_one_click_payment(
            user_id=bundle["buyer"].id,
            order_id=order.id,
            billing_key_id=bundle["billing_key"].id,
            idempotency_key="oc-other-key",
        )


@pytest.mark.asyncio
async def test_one_click_resale_transfers_ownership(db_session):
    """RESALE_BUY 원클릭 결제 시 confirm 경로와 동일한 소유권 이전이 일어나야 한다."""
    bundle = await _create_one_click_bundle(db_session, order_type=OrderType.RESALE_BUY)
    order = bundle["order"]
    listing = bundle["listing"]
    ticket = bundle["resale_ticket"]
    buyer = bundle["buyer"]
    seller = bundle["seller"]

    svc = PaymentService(db_session)
    resp = await svc.process_one_click_payment(
        user_id=buyer.id,
        order_id=order.id,
        billing_key_id=bundle["billing_key"].id,
        idempotency_key="oc-resale-1",
    )
    assert resp.status == "confirmed"

    # 1. 리스팅 → SOLD
    await db_session.refresh(listing)
    assert listing.status == ResaleListingStatus.SOLD

    # 2. 티켓 소유권 이전 + 디바이스 바인딩 무효화
    await db_session.refresh(ticket)
    assert ticket.current_owner_id == buyer.id
    assert ticket.transfer_count == 1
    assert ticket.device_hash is None
    assert ticket.totp_seed is None

    # 3. OwnershipTransfer 레코드 (수수료는 listing 스냅샷)
    transfer = (
        await db_session.execute(
            select(OwnershipTransfer).where(OwnershipTransfer.ticket_id == ticket.id)
        )
    ).scalar_one()
    assert transfer.from_user_id == seller.id
    assert transfer.to_user_id == buyer.id
    assert transfer.transfer_type == TransferType.RESALE
    assert float(transfer.price) == float(listing.asking_price)
    assert float(transfer.seller_amount) == float(listing.seller_receives)
    assert transfer.status == "completed"


@pytest.mark.asyncio
async def test_one_click_definitive_pg_failure_marks_attempt_failed(db_session, monkeypatch):
    """PG 확정 거부 시: 주문은 PAYMENT_REQUIRED 유지 + 시도 FAILED 기록.

    다음 시도는 카운터가 올라간 새 payment_id로 진행되어야 한다.
    """
    bundle = await _create_one_click_bundle(db_session)
    order = bundle["order"]
    svc = PaymentService(db_session)

    async def _reject(**kwargs):
        raise ValueError("card declined")

    monkeypatch.setattr(svc.gateway, "pay_with_billing_key", _reject)
    with pytest.raises(ValueError, match="card declined"):
        await svc.process_one_click_payment(
            user_id=bundle["buyer"].id,
            order_id=order.id,
            billing_key_id=bundle["billing_key"].id,
            idempotency_key="oc-fail-1",
        )

    await db_session.refresh(order)
    assert order.status == OrderStatus.PAYMENT_REQUIRED
    # 크래시 복구 핵심: 청구 시도의 payment_id가 PG 호출 전에 주문에 영속화됨
    assert order.payment_id == f"ord_{order.id.hex}_a1"

    attempt = (
        await db_session.execute(
            select(PaymentAttempt).where(PaymentAttempt.order_id == order.id)
        )
    ).scalar_one()
    assert attempt.status == PaymentAttemptStatus.FAILED
    assert "card declined" in (attempt.error_message or "")

    # 재시도(정상 게이트웨이 — svc2는 패치되지 않은 자체 gateway 인스턴스 보유)
    # → 새 attempt_no=2, 새 payment_id
    svc2 = PaymentService(db_session)
    resp = await svc2.process_one_click_payment(
        user_id=bundle["buyer"].id,
        order_id=order.id,
        billing_key_id=bundle["billing_key"].id,
        idempotency_key="oc-fail-1",
    )
    assert resp.status == "confirmed"
    await db_session.refresh(order)
    assert order.payment_id == f"ord_{order.id.hex}_a2"

    attempts = (
        await db_session.execute(
            select(PaymentAttempt)
            .where(PaymentAttempt.order_id == order.id)
            .order_by(PaymentAttempt.attempt_no)
        )
    ).scalars().all()
    assert [a.attempt_no for a in attempts] == [1, 2]
    assert attempts[1].status == PaymentAttemptStatus.SUCCEEDED


@pytest.mark.asyncio
async def test_one_click_ambiguous_failure_reuses_payment_id(db_session, monkeypatch):
    """타임아웃 등 결과 미확정 실패 시: 시도 INITIATED 유지 → 재시도는 같은
    payment_id를 재사용해 PortOne측 멱등성으로 이중 청구를 차단한다."""
    bundle = await _create_one_click_bundle(db_session)
    order = bundle["order"]
    svc = PaymentService(db_session)

    async def _timeout(**kwargs):
        raise httpx.TimeoutException("PG timeout")

    monkeypatch.setattr(svc.gateway, "pay_with_billing_key", _timeout)
    with pytest.raises(httpx.TimeoutException):
        await svc.process_one_click_payment(
            user_id=bundle["buyer"].id,
            order_id=order.id,
            billing_key_id=bundle["billing_key"].id,
        )

    attempt = (
        await db_session.execute(
            select(PaymentAttempt).where(PaymentAttempt.order_id == order.id)
        )
    ).scalar_one()
    # 결과 미확정 — FAILED로 단정하지 않음 (실제로 청구됐을 수 있음)
    assert attempt.status == PaymentAttemptStatus.INITIATED
    assert attempt.payment_id == f"ord_{order.id.hex}_a1"

    # 재시도 (svc2는 패치되지 않은 자체 gateway 인스턴스 보유)
    # → 같은 attempt/payment_id 재사용 (새 paymentId로 이중 청구 금지)
    svc2 = PaymentService(db_session)
    resp = await svc2.process_one_click_payment(
        user_id=bundle["buyer"].id,
        order_id=order.id,
        billing_key_id=bundle["billing_key"].id,
    )
    assert resp.status == "confirmed"
    attempts = (
        await db_session.execute(
            select(PaymentAttempt).where(PaymentAttempt.order_id == order.id)
        )
    ).scalars().all()
    assert len(attempts) == 1
    assert attempts[0].payment_id == f"ord_{order.id.hex}_a1"
    assert attempts[0].status == PaymentAttemptStatus.SUCCEEDED


@pytest.mark.asyncio
async def test_one_click_different_card_retry_starts_new_attempt(db_session, monkeypatch):
    """결함1: INITIATED attempt가 남아있어도 *다른 카드*로 재시도하면 같은
    payment_id를 재사용해선 안 된다. PortOne 멱등성은 payment_id 기준이라 첫
    카드(A)가 PG에서 실제 성공했다면 같은 payment_id로는 카드 A 청구가 굳는다.
    → 다른 카드 재시도는 새 attempt(attempt_no+1, 새 payment_id)로 진행되어야 한다.

    (테스트 DB 스키마는 user당 BillingKey 1행만 허용하므로, 1차에 카드 A로
    INITIATED를 만든 뒤 카드 A를 비활성/삭제(attempt.billing_key_id는 FK
    ON DELETE SET NULL로 NULL이 됨)하고 카드 B를 새로 등록해 재시도한다.
    서비스의 재사용 판정은 billing_key_id 동등성만 보므로 NULL != 카드B → 새 attempt.)"""
    bundle = await _create_one_click_bundle(db_session)
    order = bundle["order"]
    buyer = bundle["buyer"]
    card_a_id = bundle["billing_key"].id
    svc = PaymentService(db_session)

    # 1차: 카드 A로 타임아웃 → INITIATED 유지
    async def _timeout(**kwargs):
        raise httpx.TimeoutException("PG timeout")

    monkeypatch.setattr(svc.gateway, "pay_with_billing_key", _timeout)
    with pytest.raises(httpx.TimeoutException):
        await svc.process_one_click_payment(
            user_id=buyer.id,
            order_id=order.id,
            billing_key_id=card_a_id,
        )

    attempt = (
        await db_session.execute(
            select(PaymentAttempt).where(PaymentAttempt.order_id == order.id)
        )
    ).scalar_one()
    assert attempt.status == PaymentAttemptStatus.INITIATED
    assert attempt.billing_key_id == card_a_id
    assert attempt.payment_id == f"ord_{order.id.hex}_a1"

    # 카드 A 삭제 → attempt.billing_key_id는 ON DELETE SET NULL로 NULL.
    # 그 후 카드 B 등록(user당 1행 제약 충족).
    await db_session.delete(bundle["billing_key"])
    await db_session.flush()
    bk_b = BillingKey(
        user_id=buyer.id,
        billing_key=f"mock_bk_{uuid.uuid4().hex[:12]}",
        card_type="credit",
        last_four="1111",
        card_brand="MASTER",
        is_default=True,
    )
    db_session.add(bk_b)
    await db_session.commit()

    # 2차: 카드 B로 재시도 → 1차 attempt의 billing_key_id(NULL) != 카드 B → 새 attempt
    svc2 = PaymentService(db_session)
    resp = await svc2.process_one_click_payment(
        user_id=buyer.id,
        order_id=order.id,
        billing_key_id=bk_b.id,
    )
    assert resp.status == "confirmed"

    attempts = (
        await db_session.execute(
            select(PaymentAttempt)
            .where(PaymentAttempt.order_id == order.id)
            .order_by(PaymentAttempt.attempt_no)
        )
    ).scalars().all()
    assert len(attempts) == 2
    assert [a.attempt_no for a in attempts] == [1, 2]
    # 1차 attempt는 INITIATED 그대로, payment_id 유지 (재사용 안 됨)
    assert attempts[0].payment_id == f"ord_{order.id.hex}_a1"
    assert attempts[0].status == PaymentAttemptStatus.INITIATED
    # 2차는 새 payment_id + 카드 B로 성공
    assert attempts[1].billing_key_id == bk_b.id
    assert attempts[1].payment_id == f"ord_{order.id.hex}_a2"
    assert attempts[1].status == PaymentAttemptStatus.SUCCEEDED
    assert order.payment_id == f"ord_{order.id.hex}_a2"


@pytest.mark.asyncio
async def test_one_click_same_card_retry_reuses_attempt(db_session, monkeypatch):
    """결함1 회귀 가드: *같은 카드*로 INITIATED 재시도는 기존대로 attempt/payment_id를
    재사용해 PortOne 멱등성으로 이중 청구를 막아야 한다(기존 동작 보존)."""
    bundle = await _create_one_click_bundle(db_session)
    order = bundle["order"]
    buyer = bundle["buyer"]
    card_id = bundle["billing_key"].id
    svc = PaymentService(db_session)

    async def _timeout(**kwargs):
        raise httpx.TimeoutException("PG timeout")

    monkeypatch.setattr(svc.gateway, "pay_with_billing_key", _timeout)
    with pytest.raises(httpx.TimeoutException):
        await svc.process_one_click_payment(
            user_id=buyer.id, order_id=order.id, billing_key_id=card_id
        )

    svc2 = PaymentService(db_session)
    resp = await svc2.process_one_click_payment(
        user_id=buyer.id, order_id=order.id, billing_key_id=card_id
    )
    assert resp.status == "confirmed"

    attempts = (
        await db_session.execute(
            select(PaymentAttempt).where(PaymentAttempt.order_id == order.id)
        )
    ).scalars().all()
    assert len(attempts) == 1
    assert attempts[0].payment_id == f"ord_{order.id.hex}_a1"
    assert attempts[0].status == PaymentAttemptStatus.SUCCEEDED
