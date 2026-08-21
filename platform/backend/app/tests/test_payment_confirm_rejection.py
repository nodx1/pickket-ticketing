"""결제 확정 거부 경로 M-1 방어 테스트 (Blocker #2).

- confirm 거부(마감 초과·fraud block) 시 자동 PG 환불 + 기록
- 터미널(EXPIRED/CANCELLED) 주문에 늦은 paid 웹훅 → 자동 환불 + 알림 + 메타
- 웹훅 리플레이 가드: dedup 키를 처리 성공 후 확정 (실패 시 재시도 허용)
- 양방향 대사: 역방향 주문 스캔 + payment_attempts 고아 스캔
"""

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus, OrderType
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.services.payment_service import (
    WEBHOOK_DEADLINE_GRACE_SECONDS,
    PaymentConfirmationRejected,
    PaymentService,
)


# ── Async fixtures: 주문 번들 ─────────────────────────────────────────


async def _create_order_bundle(
    db_session,
    *,
    order_status: OrderStatus = OrderStatus.PAYMENT_REQUIRED,
    payment_deadline: datetime | None = None,
    payment_id: str = "pay_reject_test",
    payment_metadata: dict | None = None,
    unit_price: float = 50.0,
):
    """Order + PENDING 티켓 번들 생성."""
    now = datetime.now(timezone.utc)
    organizer = User(
        email=f"rej_org_{uuid.uuid4().hex[:8]}@test.com",
        hashed_password="x",
        name="Org",
        is_organizer=True,
    )
    buyer = User(
        email=f"rej_buyer_{uuid.uuid4().hex[:8]}@test.com",
        hashed_password="x",
        name="Buyer",
    )
    db_session.add_all([organizer, buyer])
    await db_session.flush()

    event = Event(
        organizer_id=organizer.id,
        title="Reject Test Event",
        slug=f"test-reject-{uuid.uuid4().hex[:8]}",
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

    order = Order(
        user_id=buyer.id,
        event_id=event.id,
        tier_id=tier.id,
        order_type=OrderType.PURCHASE,
        status=order_status,
        quantity=1,
        unit_price=unit_price,
        total_amount=unit_price,
        payment_id=payment_id,
        payment_deadline=payment_deadline,
        payment_currency="KRW",
        payment_metadata=payment_metadata,
    )
    db_session.add(order)
    await db_session.flush()

    ticket = Ticket(
        event_id=event.id,
        tier_id=tier.id,
        original_owner_id=buyer.id,
        current_owner_id=buyer.id,
        purchase_price=unit_price,
        sale_mode="fixed_fcfs",
        purchase_order_id=order.id,
        status=TicketStatus.PENDING,
    )
    db_session.add(ticket)
    await db_session.flush()

    return {"buyer": buyer, "order": order, "ticket": ticket, "tier": tier}


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


def _paid_webhook_body(payment_id: str, txn_id: str, amount: float, event_id: str) -> bytes:
    return json.dumps(
        {
            "type": "Transaction.Paid",
            "id": event_id,
            "data": {
                "paymentId": payment_id,
                "transactionId": txn_id,
                "amount": {"total": amount},
            },
        }
    ).encode()


class _CountingVoidGateway:
    """gateway.void_authorization 호출을 세는 프록시."""

    def __init__(self, inner, *, voided: bool = True):
        self._inner = inner
        self._voided = voided
        self.void_calls = 0

    def __getattr__(self, name):
        return getattr(self._inner, name)

    async def void_authorization(self, *, payment_id, reason):
        self.void_calls += 1
        result = await self._inner.void_authorization(payment_id=payment_id, reason=reason)
        result.voided = self._voided
        return result


# ═══════════════════════════════════════════════════════════════════
# 2-a: 마감 초과 paid 웹훅 → grace 밖이면 자동 환불, 안이면 확정
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_late_paid_webhook_beyond_grace_auto_refunds(db_session):
    """마감 + grace 초과 후 도착한 paid 웹훅 → 자동 PG 환불 + 주문 CANCELLED + 200 ack."""
    deadline = datetime.now(timezone.utc) - timedelta(
        seconds=WEBHOOK_DEADLINE_GRACE_SECONDS + 120
    )
    bundle = await _create_order_bundle(
        db_session,
        payment_deadline=deadline,
        payment_id="pay_late_refund",
    )
    order = bundle["order"]
    svc = PaymentService(db_session)
    counting = _CountingVoidGateway(svc.gateway)
    svc.gateway = counting

    result = await svc.handle_portone_webhook(
        raw_body=_paid_webhook_body("pay_late_refund", "txn_late_1", 50.0, "evt-late-1")
    )

    # 환불 완료 → 재시도 무의미 → propagation 없이 ack
    assert result is None
    assert counting.void_calls == 1

    await db_session.flush()
    await db_session.refresh(order)
    assert order.status == OrderStatus.CANCELLED
    refund_meta = order.payment_metadata["confirm_rejected_refund"]
    assert refund_meta["refunded"] is True
    assert refund_meta["reason"] == "payment_deadline_expired"
    assert refund_meta["source"] == "webhook"

    await db_session.refresh(bundle["ticket"])
    assert bundle["ticket"].status == TicketStatus.CANCELLED


@pytest.mark.asyncio
async def test_late_paid_webhook_within_grace_confirms(db_session):
    """마감 직후 grace 윈도우 내 도착한 paid 웹훅 → 정상 확정 (환불 아님)."""
    deadline = datetime.now(timezone.utc) - timedelta(
        seconds=WEBHOOK_DEADLINE_GRACE_SECONDS // 2
    )
    bundle = await _create_order_bundle(
        db_session,
        payment_deadline=deadline,
        payment_id="pay_grace_confirm",
    )
    order = bundle["order"]
    svc = PaymentService(db_session)
    counting = _CountingVoidGateway(svc.gateway)
    svc.gateway = counting

    result = await svc.handle_portone_webhook(
        raw_body=_paid_webhook_body("pay_grace_confirm", "txn_grace_1", 50.0, "evt-grace-1")
    )

    assert result and result[0]["event"] == "order.payment.confirmed"
    assert counting.void_calls == 0
    await db_session.refresh(order)
    assert order.status == OrderStatus.CONFIRMED


@pytest.mark.asyncio
async def test_client_confirm_after_deadline_refunds_and_raises(db_session):
    """클라이언트 confirm도 마감 초과 시 PG paid 확인 후 자동 환불 + 거부."""
    deadline = datetime.now(timezone.utc) - timedelta(minutes=30)
    bundle = await _create_order_bundle(
        db_session,
        payment_deadline=deadline,
        payment_id="pay_client_late",
    )
    svc = PaymentService(db_session)
    counting = _CountingVoidGateway(svc.gateway)
    svc.gateway = counting

    with pytest.raises(PaymentConfirmationRejected, match="deadline has expired") as ei:
        await svc.confirm_payment(
            bundle["order"].id,
            pg_txn_id="txn_client_late",
            payment_id="pay_client_late",
            amount=50.0,
        )
    assert ei.value.refunded is True
    assert counting.void_calls == 1


# ═══════════════════════════════════════════════════════════════════
# 2-a: fraud block → 무조건 자동 환불
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_fraud_block_auto_refunds(db_session, monkeypatch):
    """fraud block 판정 시 (PG paid 확인 후이므로) 무조건 PG 환불 + CANCELLED."""
    from app.services.fraud_detector import FraudScore

    bundle = await _create_order_bundle(
        db_session,
        payment_deadline=datetime.now(timezone.utc) + timedelta(minutes=15),
        payment_id="pay_fraud_refund",
    )
    order = bundle["order"]

    async def _block_fraud(*, db, order_id, user_id, amount, card_hash=None):
        return FraudScore(
            order_id=order_id,
            user_id=user_id,
            total_score=95,
            card_velocity_score=40,
            amount_anomaly_score=30,
            geo_velocity_score=10,
            device_score=10,
            failure_pattern_score=5,
            reasons=["test_block"],
        )

    import app.services.payment_service as ps_mod

    monkeypatch.setattr(ps_mod, "analyze_fraud", _block_fraud)

    svc = PaymentService(db_session)
    counting = _CountingVoidGateway(svc.gateway)
    svc.gateway = counting

    with pytest.raises(PaymentConfirmationRejected, match="blocked by fraud") as ei:
        await svc.confirm_payment(
            order.id,
            pg_txn_id="txn_fraud_refund",
            payment_id="pay_fraud_refund",
            amount=50.0,
        )
    assert ei.value.refunded is True
    assert counting.void_calls == 1

    await db_session.flush()
    await db_session.refresh(order)
    assert order.status == OrderStatus.CANCELLED
    meta = order.payment_metadata["confirm_rejected_refund"]
    assert meta["refunded"] is True
    assert meta["reason"].startswith("fraud_block")


@pytest.mark.asyncio
async def test_webhook_refund_failure_propagates_for_retry(db_session):
    """웹훅 거부 + PG 환불 실패 → 예외 전파(5xx)로 PortOne 재시도 보존."""
    deadline = datetime.now(timezone.utc) - timedelta(
        seconds=WEBHOOK_DEADLINE_GRACE_SECONDS + 120
    )
    bundle = await _create_order_bundle(
        db_session,
        payment_deadline=deadline,
        payment_id="pay_refund_fail",
    )
    svc = PaymentService(db_session)
    svc.gateway = _CountingVoidGateway(svc.gateway, voided=False)  # 환불 실패 시뮬레이션

    with pytest.raises(PaymentConfirmationRejected) as ei:
        await svc.handle_portone_webhook(
            raw_body=_paid_webhook_body("pay_refund_fail", "txn_rf_1", 50.0, "evt-rf-1")
        )
    assert ei.value.refunded is False
    # 주문은 CANCELLED로 전이되지 않음 (환불 미완 — 재시도가 환불 재시도)
    assert bundle["order"].status == OrderStatus.PAYMENT_REQUIRED


# ═══════════════════════════════════════════════════════════════════
# 2-b: 터미널 상태(EXPIRED/CANCELLED) + 늦은 paid 웹훅
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_terminal_expired_paid_webhook_refunds_and_records(db_session):
    """EXPIRED 주문에 paid 웹훅 → 조용히 삼키지 않고 자동 환불 + 메타 기록."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.EXPIRED,
        payment_id="pay_terminal_late",
    )
    order = bundle["order"]
    svc = PaymentService(db_session)
    counting = _CountingVoidGateway(svc.gateway)
    svc.gateway = counting

    result = await svc.handle_portone_webhook(
        raw_body=_paid_webhook_body("pay_terminal_late", "txn_term_1", 50.0, "evt-term-1")
    )

    assert result is None
    assert counting.void_calls == 1
    await db_session.flush()
    await db_session.refresh(order)
    assert order.status == OrderStatus.EXPIRED  # 상태는 유지, 환불 사실만 기록
    meta = order.payment_metadata["late_paid_refund"]
    assert meta["refunded"] is True
    assert meta["payment_id"] == "pay_terminal_late"
    assert meta["order_status"] == "expired"


@pytest.mark.asyncio
async def test_terminal_paid_webhook_already_refunded_no_double_refund(db_session):
    """이미 자동 환불된 주문에 또 paid 웹훅 → 재환불 없이 ack (이중 환불 방지)."""
    prior_meta = {
        "late_paid_refund": {
            "payment_id": "pay_already_refunded",
            "refunded": True,
            "at": datetime.now(timezone.utc).isoformat(),
        }
    }
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.CANCELLED,
        payment_id="pay_already_refunded",
        payment_metadata=prior_meta,
    )
    svc = PaymentService(db_session)
    counting = _CountingVoidGateway(svc.gateway)
    svc.gateway = counting

    result = await svc.handle_portone_webhook(
        raw_body=_paid_webhook_body(
            "pay_already_refunded", "txn_dup_1", 50.0, "evt-dup-refund-1"
        )
    )
    assert result is None
    assert counting.void_calls == 0
    assert bundle["order"].status == OrderStatus.CANCELLED


@pytest.mark.asyncio
async def test_terminal_paid_webhook_refund_failure_raises_for_retry(db_session):
    """터미널 주문 환불 실패 → 5xx 전파로 PortOne 재시도가 환불 재시도."""
    await _create_order_bundle(
        db_session,
        order_status=OrderStatus.EXPIRED,
        payment_id="pay_term_fail",
    )
    svc = PaymentService(db_session)
    svc.gateway = _CountingVoidGateway(svc.gateway, voided=False)

    with pytest.raises(ValueError, match="refund failed"):
        await svc.handle_portone_webhook(
            raw_body=_paid_webhook_body("pay_term_fail", "txn_tf_1", 50.0, "evt-tf-1")
        )


# ═══════════════════════════════════════════════════════════════════
# 2-d: 웹훅 리플레이 가드 — 처리 성공 후 dedup 확정
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_replay_guard_failure_allows_retry_success_blocks_dup():
    """in-progress 락 + 성공 후 확정: 실패 시 재시도 허용, 성공 후 중복 차단."""
    from app.api.v1 import payment_webhook as pw

    event_id = f"evt-guard-{uuid.uuid4().hex[:8]}"

    # 수신 → in-progress 락 획득
    await pw._guard_replay(event_id, defer_confirm=True)

    # 처리 중 같은 이벤트 동시 수신 → 409
    with pytest.raises(HTTPException) as ei:
        await pw._guard_replay(event_id, defer_confirm=True)
    assert ei.value.status_code == 409

    # 처리 실패 → 락 해제 → PortOne 재시도가 살아남
    await pw._release_replay_guard(event_id)
    await pw._guard_replay(event_id, defer_confirm=True)  # 재시도 통과해야 함

    # 처리 성공 → dedup 키 확정 → 이후 같은 이벤트는 중복 차단
    await pw._confirm_replay_guard(event_id)
    with pytest.raises(HTTPException) as ei2:
        await pw._guard_replay(event_id, defer_confirm=True)
    assert ei2.value.status_code == 409


def test_expiry_grace_covers_webhook_grace():
    """payment_expiry 만료 grace는 웹훅 확정 grace보다 길어야 한다 (M-1)."""
    from app.tasks.payment_expiry import EXPIRY_GRACE_SECONDS

    assert EXPIRY_GRACE_SECONDS > WEBHOOK_DEADLINE_GRACE_SECONDS


# ═══════════════════════════════════════════════════════════════════
# 2-c: 양방향 대사 (sync 컨텍스트 — 직접 헬퍼 호출)
# ═══════════════════════════════════════════════════════════════════


@compiles(PG_UUID, "sqlite")
def _compile_pg_uuid_sqlite(type_, compiler, **kw):
    return "CHAR(32)"


class _FakeSyncRedis:
    def __init__(self, store: dict):
        self.store = store

    def exists(self, key):
        return key in self.store

    def setex(self, key, ttl, value):
        self.store[key] = value

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    def get(self, key):
        return self.store.get(key)

    def delete(self, key):
        self.store.pop(key, None)


@pytest.fixture()
def sync_db(monkeypatch):
    from app.core.database import Base

    engine = create_engine("sqlite://", echo=False)
    SessionFactory = sessionmaker(engine)
    Base.metadata.create_all(engine)

    store: dict = {}
    monkeypatch.setattr(
        "app.tasks.reconciliation._get_sync_redis", lambda: _FakeSyncRedis(store)
    )
    session = SessionFactory()
    yield session, store
    session.close()
    Base.metadata.drop_all(engine)


def _create_sync_order(session, *, status, payment_id, created_at=None, pg_provider="portone"):
    now = datetime.now(timezone.utc)
    event = Event(
        organizer_id=uuid.uuid4(),
        title="Recon Event",
        slug=f"test-recon-{uuid.uuid4().hex[:8]}",
        venue="Arena",
        event_date=now + timedelta(days=10),
        bidding_opens_at=now - timedelta(days=2),
        bidding_closes_at=now + timedelta(days=1),
        total_seats=100,
    )
    session.add(event)
    session.flush()
    order = Order(
        user_id=uuid.uuid4(),
        event_id=event.id,
        status=status,
        quantity=1,
        unit_price=10000,
        total_amount=10000,
        payment_id=payment_id,
        # A1: 대사 provider 라우팅 검증 — 이 테스트들은 PortOne 라이브 환불 경로.
        pg_provider=pg_provider,
    )
    session.add(order)
    session.flush()
    if created_at:
        order.created_at = created_at
    session.commit()
    return order


def test_reverse_scan_detects_pg_paid_terminal_order_and_refunds(sync_db, monkeypatch):
    """역방향 대사: DB EXPIRED · PG paid → 불일치 기록 + 자동 환불."""
    from app.models.reconciliation import (
        MismatchType,
        ReconciliationBatch,
        ReconciliationStatus,
    )
    from app.tasks import reconciliation as recon

    session, store = sync_db
    # A1: PortOne 라이브 대사 경로 — mock 스킵 방지.
    from app.core.config import settings as _cfg
    monkeypatch.setattr(_cfg, "PORTONE_MOCK_MODE", False, raising=False)
    order = _create_sync_order(
        session, status=OrderStatus.EXPIRED, payment_id="pay_reverse_1"
    )
    batch = ReconciliationBatch(
        target_date=datetime.now(timezone.utc), status=ReconciliationStatus.RUNNING
    )
    session.add(batch)
    session.flush()

    monkeypatch.setattr(
        recon,
        "_verify_payment_sync",
        lambda **kw: {"amount": 10000.0, "status": "paid", "raw": {}},
    )
    cancel_calls = []

    def _fake_cancel(*, payment_id, reason, provider=None):
        cancel_calls.append((payment_id, reason))
        return True, {"status": "cancelled"}

    monkeypatch.setattr(recon, "_cancel_payment_sync", _fake_cancel)

    mismatches: list = []
    now = datetime.now(timezone.utc)
    stats = recon._reverse_scan_unconfirmed_orders(
        session, batch, mismatches, now - timedelta(days=1), now + timedelta(days=1)
    )

    assert stats == {"orders_checked": 1, "orders_flagged": 1, "orders_refunded": 1}
    assert len(mismatches) == 1
    assert mismatches[0].mismatch_type == MismatchType.STATUS_MISMATCH
    assert mismatches[0].details["direction"] == "pg_paid_db_unconfirmed"
    assert cancel_calls == [("pay_reverse_1", "reconciliation:pg_paid_terminal_order")]
    assert order.payment_metadata["reconciliation_refund"]["refunded"] is True
    # 멱등 키 확정 → 재실행 시 재환불 없음
    assert f"v2:reconcile:{order.id}:reverse_refund" in store

    mismatches2: list = []
    stats2 = recon._reverse_scan_unconfirmed_orders(
        session, batch, mismatches2, now - timedelta(days=1), now + timedelta(days=1)
    )
    assert stats2["orders_refunded"] == 0
    assert len(cancel_calls) == 1


def test_orphan_attempt_scan_refunds_duplicate_charge(sync_db, monkeypatch):
    """payment_attempts 고아 스캔: 주문이 다른 payment_id로 확정(이중청구) → 환불."""
    from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus
    from app.models.reconciliation import (
        MismatchType,
        ReconciliationBatch,
        ReconciliationStatus,
    )
    from app.tasks import reconciliation as recon

    session, store = sync_db
    # A1: PortOne 라이브 대사 경로 — mock 스킵 방지.
    from app.core.config import settings as _cfg
    monkeypatch.setattr(_cfg, "PORTONE_MOCK_MODE", False, raising=False)
    # 주문은 attempt 2(payment_id=..._a2)로 확정됨; attempt 1이 PG에서 paid인 고아
    order = _create_sync_order(
        session, status=OrderStatus.CONFIRMED, payment_id="pay_orphan_a2"
    )
    attempt = PaymentAttempt(
        order_id=order.id,
        attempt_no=1,
        payment_id="pay_orphan_a1",
        amount=10000,
        currency="KRW",
        status=PaymentAttemptStatus.INITIATED,
        created_at=datetime.now(timezone.utc) - timedelta(hours=2),
    )
    session.add(attempt)
    session.commit()

    batch = ReconciliationBatch(
        target_date=datetime.now(timezone.utc), status=ReconciliationStatus.RUNNING
    )
    session.add(batch)
    session.flush()

    monkeypatch.setattr(
        recon,
        "_verify_payment_sync",
        lambda **kw: {"amount": 10000.0, "status": "paid", "raw": {}},
    )
    cancel_calls = []

    def _fake_cancel(*, payment_id, reason, provider=None):
        cancel_calls.append(payment_id)
        return True, {"status": "cancelled"}

    monkeypatch.setattr(recon, "_cancel_payment_sync", _fake_cancel)

    mismatches: list = []
    stats = recon._scan_orphan_payment_attempts(session, batch, mismatches)

    assert stats == {"attempts_checked": 1, "attempts_flagged": 1, "attempts_refunded": 1}
    assert cancel_calls == ["pay_orphan_a1"]
    assert len(mismatches) == 1
    assert mismatches[0].mismatch_type == MismatchType.MISSING_IN_DB
    assert attempt.status == PaymentAttemptStatus.SUCCEEDED
    assert "refunded" in attempt.error_message


def test_orphan_attempt_scan_converges_without_refund(sync_db, monkeypatch):
    """고아 스캔 수렴 케이스: 같은 payment_id로 확정 → SUCCEEDED, PG failed → FAILED."""
    from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus
    from app.models.reconciliation import ReconciliationBatch, ReconciliationStatus
    from app.tasks import reconciliation as recon

    session, _store = sync_db
    # A1: PortOne 라이브 대사 경로 — mock 스킵 방지.
    from app.core.config import settings as _cfg
    monkeypatch.setattr(_cfg, "PORTONE_MOCK_MODE", False, raising=False)
    confirmed_order = _create_sync_order(
        session, status=OrderStatus.CONFIRMED, payment_id="pay_conv_a1"
    )
    converged = PaymentAttempt(
        order_id=confirmed_order.id,
        attempt_no=1,
        payment_id="pay_conv_a1",
        amount=10000,
        currency="KRW",
        status=PaymentAttemptStatus.INITIATED,
        created_at=datetime.now(timezone.utc) - timedelta(hours=2),
    )
    failed_order = _create_sync_order(
        session, status=OrderStatus.PAYMENT_REQUIRED, payment_id="pay_failed_a1"
    )
    failed_attempt = PaymentAttempt(
        order_id=failed_order.id,
        attempt_no=1,
        payment_id="pay_failed_a1",
        amount=10000,
        currency="KRW",
        status=PaymentAttemptStatus.INITIATED,
        created_at=datetime.now(timezone.utc) - timedelta(hours=2),
    )
    session.add_all([converged, failed_attempt])
    session.commit()

    batch = ReconciliationBatch(
        target_date=datetime.now(timezone.utc), status=ReconciliationStatus.RUNNING
    )
    session.add(batch)
    session.flush()

    def _fake_verify(*, transaction_id, **kw):
        if transaction_id == "pay_conv_a1":
            return {"amount": 10000.0, "status": "paid", "raw": {}}
        return {"amount": 0.0, "status": "failed", "raw": {}}

    monkeypatch.setattr(recon, "_verify_payment_sync", _fake_verify)
    monkeypatch.setattr(
        recon,
        "_cancel_payment_sync",
        lambda **kw: pytest.fail("수렴 케이스에서 환불이 호출되면 안 됨"),
    )

    mismatches: list = []
    stats = recon._scan_orphan_payment_attempts(session, batch, mismatches)

    assert stats["attempts_flagged"] == 0
    assert mismatches == []
    assert converged.status == PaymentAttemptStatus.SUCCEEDED
    assert failed_attempt.status == PaymentAttemptStatus.FAILED


# ═══════════════════════════════════════════════════════════════════
# 2-d: 환불 대사 (_scan_refunds) — 원장은 환불인데 PG 에서 안 빠진 건
#
# 🔴 왜 여기 붙는가 (2026-08-04, 배포 세션 지적)
#
#     최초 배포 때 검증은 실 PG 스크립트(scripts/verify/refund_reconciliation_pg.py)
#     6 PASS + 뮤테이션 M1~M5 사망으로 했다. 그건 목킹보다 세지만 **testpaths 밖**이라
#     회귀 스위트가 이 코드를 한 줄도 안 지킨다 — 다음에 reconciliation.py 를 고치는
#     사람에겐 보호막이 0 이었다. 대사는 하루 한 번만 돌아 깨져도 늦게 안다.
#
#     ⚠️ 이 픽스처 테스트가 실 PG 스크립트를 **대체하지 않는다**. SQLite 로는
#        동시성·트랜잭션 경계를 증명할 수 없다. 여기서 지키는 것은 **판정 규칙**이다.
# ═══════════════════════════════════════════════════════════════════


def _create_refund_pair(
    session,
    *,
    processed_at,
    captured_at=None,
    refund_type="full",
    refund_status="completed",
    deleted_at=None,
    pg_transaction_id="tid_refund_1",
    amount=10000,
):
    """환불 대사 대상 1쌍(주문 + 환불)을 만든다."""
    from app.models.refund import Refund

    order = _create_sync_order(
        session, status=OrderStatus.REFUNDED, payment_id=f"pay_{uuid.uuid4().hex[:8]}"
    )
    order.pg_transaction_id = pg_transaction_id
    order.captured_at = captured_at or processed_at
    refund = Refund(
        order_id=order.id,
        refund_type=refund_type,
        status=refund_status,
        amount=amount,
        currency="KRW",
        reason="테스트 환불",
        initiated_by="user",
        processed_at=processed_at,
        deleted_at=deleted_at,
    )
    session.add(refund)
    session.commit()
    return order, refund


@pytest.fixture()
def _recon_window():
    now = datetime.now(timezone.utc)
    return now - timedelta(days=1), now + timedelta(days=1)


def _run_refund_scan(session, monkeypatch, window, *, pg_result):
    """_scan_refunds 를 실행하고 (stats, mismatches) 를 돌려준다."""
    from app.core.config import settings as _cfg
    from app.models.reconciliation import ReconciliationBatch, ReconciliationStatus
    from app.tasks import reconciliation as recon

    monkeypatch.setattr(_cfg, "PORTONE_MOCK_MODE", False, raising=False)
    batch = ReconciliationBatch(
        target_date=datetime.now(timezone.utc), status=ReconciliationStatus.RUNNING
    )
    session.add(batch)
    session.flush()

    if callable(pg_result):
        monkeypatch.setattr(recon, "_verify_payment_for_order", pg_result)
    else:
        monkeypatch.setattr(recon, "_verify_payment_for_order", lambda order: pg_result)
    # durable 기록은 별도 세션을 열어 SQLite 픽스처와 무관하다 — 여기선 무해화.
    monkeypatch.setattr(recon, "_record_lookup_failure", lambda **kw: None)

    mismatches: list = []
    stats = recon._scan_refunds(session, batch, mismatches, window[0], window[1])
    return stats, mismatches


def test_refund_scan_flags_pg_still_paid(sync_db, monkeypatch, _recon_window):
    """🔴 핵심 결함: 원장은 환불 완료인데 PG 는 아직 살아 있다 → 불일치 기록."""
    from app.models.reconciliation import MismatchType

    session, _store = sync_db
    order, refund = _create_refund_pair(session, processed_at=datetime.now(timezone.utc))

    stats, mismatches = _run_refund_scan(
        session, monkeypatch, _recon_window,
        pg_result={"amount": 10000.0, "status": "paid", "raw": {}},
    )

    assert stats == {"refunds_checked": 1, "refunds_flagged": 1, "refunds_unknown": 0}
    assert len(mismatches) == 1
    m = mismatches[0]
    assert m.mismatch_type == MismatchType.STATUS_MISMATCH
    assert m.order_id == order.id
    assert m.db_status == "refunded"
    assert m.pg_status == "paid"
    # 🔴 마이그레이션 0건 — enum 을 재사용하므로 details.scan 이 유일한 구분자다.
    #    이게 빠지면 정방향 불일치와 섞여 운영자가 원인을 못 가른다.
    assert m.details["scan"] == "refund"
    assert m.details["refund_id"] == str(refund.id)


def test_refund_scan_passes_normal_cancelled_refund(sync_db, monkeypatch, _recon_window):
    """🔴 정상 환불의 PG 상태는 cancelled 다 — 사고로 찍히면 안 된다.

    정방향의 허용목록(paid/captured/succeeded/completed)을 그대로 재사용하면
    **정상 환불이 전부 STATUS_MISMATCH 로 찍힌다.** 여기서는 판정이 반대다.
    """
    session, _store = sync_db
    _create_refund_pair(session, processed_at=datetime.now(timezone.utc))

    for pg_status in ("cancelled", "canceled", "refunded", "partialcancelled"):
        stats, mismatches = _run_refund_scan(
            session, monkeypatch, _recon_window,
            pg_result={"amount": 10000.0, "status": pg_status, "raw": {}},
        )
        assert stats["refunds_checked"] == 1, pg_status
        assert stats["refunds_flagged"] == 0, pg_status
        assert mismatches == [], pg_status


def test_refund_scan_flags_missing_transaction(sync_db, monkeypatch, _recon_window):
    """PG 에 거래 자체가 없다 → MISSING_IN_PG(환불 이전에 결제가 없었다)."""
    from app.models.reconciliation import MismatchType

    session, _store = sync_db
    _create_refund_pair(session, processed_at=datetime.now(timezone.utc))

    stats, mismatches = _run_refund_scan(
        session, monkeypatch, _recon_window, pg_result=None
    )

    assert stats["refunds_flagged"] == 1
    assert mismatches[0].mismatch_type == MismatchType.MISSING_IN_PG
    assert mismatches[0].pg_amount is None
    assert mismatches[0].details["scan"] == "refund"


def test_refund_scan_holds_on_lookup_failure(sync_db, monkeypatch, _recon_window):
    """🔴 조회 실패를 「환불 안 됨」으로 읽지 않는다 (F17 과 같은 규칙).

    타임아웃·5xx 를 불일치로 적으면 멀쩡한 환불이 사고로 찍히고, 운영자는 있지도
    않은 사고를 쫓는다. 「모르겠다」는 「없다」가 아니다.
    """
    from app.tasks import reconciliation as recon

    session, _store = sync_db
    _create_refund_pair(session, processed_at=datetime.now(timezone.utc))

    stats, mismatches = _run_refund_scan(
        session, monkeypatch, _recon_window,
        pg_result=recon._LookupFailed("timeout"),
    )

    assert stats == {"refunds_checked": 1, "refunds_flagged": 0, "refunds_unknown": 1}
    assert mismatches == []


def test_refund_scan_window_is_processed_at_not_capture_date(
    sync_db, monkeypatch, _recon_window
):
    """🔴 창은 refunds.processed_at 이다 — 결제일(captured_at)이 아니다.

    정방향은 captured_at 으로 창을 잡는다. 환불에 그걸 쓰면 **8/20 결제·8/22 환불이
    영원히 대사되지 않는다**(8/20 배치는 이미 지나갔다). 대회 기간이 정확히 그 모양이다.
    """
    session, _store = sync_db
    now = datetime.now(timezone.utc)
    # 결제는 열흘 전(창 밖) · 환불은 오늘(창 안) → **세어져야 한다**
    _create_refund_pair(
        session, processed_at=now, captured_at=now - timedelta(days=10)
    )

    stats, _ = _run_refund_scan(
        session, monkeypatch, _recon_window,
        pg_result={"amount": 10000.0, "status": "cancelled", "raw": {}},
    )
    assert stats["refunds_checked"] == 1

    # 반대로 환불 처리 시각이 창 밖이면 세지 않는다
    from app.models.refund import Refund

    session.query(Refund).update({Refund.processed_at: now - timedelta(days=5)})
    session.commit()
    stats2, _ = _run_refund_scan(
        session, monkeypatch, _recon_window,
        pg_result={"amount": 10000.0, "status": "cancelled", "raw": {}},
    )
    assert stats2["refunds_checked"] == 0


def test_refund_scan_scope_is_completed_full_refunds_only(sync_db, monkeypatch, _recon_window):
    """1차 범위: 전액·완료·미삭제만. 부분취소는 새 TID 라 옛 번호로 물으면 취소 전 값이 온다."""
    session, _store = sync_db
    now = datetime.now(timezone.utc)

    _create_refund_pair(
        session, processed_at=now, refund_type="partial", pg_transaction_id="tid_partial"
    )
    _create_refund_pair(
        session, processed_at=now, refund_status="pending", pg_transaction_id="tid_pending"
    )
    _create_refund_pair(
        session, processed_at=now, deleted_at=now, pg_transaction_id="tid_deleted"
    )

    stats, mismatches = _run_refund_scan(
        session, monkeypatch, _recon_window,
        pg_result={"amount": 10000.0, "status": "paid", "raw": {}},
    )

    assert stats["refunds_checked"] == 0
    assert mismatches == []


def test_refund_scan_skips_orders_without_pg_transaction_id(
    sync_db, monkeypatch, _recon_window
):
    """PG 거래번호가 없으면 물어볼 대상 자체가 없다 — 조회 없이 건너뛴다."""
    session, _store = sync_db
    _create_refund_pair(
        session, processed_at=datetime.now(timezone.utc), pg_transaction_id=None
    )

    def _must_not_be_called(order):  # pragma: no cover - 호출되면 실패
        raise AssertionError("pg_transaction_id 가 없는 주문을 PG 에 물었다")

    stats, mismatches = _run_refund_scan(
        session, monkeypatch, _recon_window, pg_result=_must_not_be_called
    )
    assert stats["refunds_checked"] == 0
    assert mismatches == []
