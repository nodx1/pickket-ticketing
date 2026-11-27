import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus, OrderType
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.services.payment_service import PaymentService


async def _create_order_bundle(
    db_session,
    *,
    order_status: OrderStatus,
    quantity: int = 1,
    unit_price: float = 50.0,
    payment_deadline: datetime | None = None,
    payment_id: str | None = None,
):
    now = datetime.now(timezone.utc)
    organizer = User(
        email=f"svc_org_{uuid.uuid4().hex[:8]}@test.com",
        hashed_password="x",
        name="Org",
        is_organizer=True,
    )
    buyer = User(
        email=f"svc_buyer_{uuid.uuid4().hex[:8]}@test.com",
        hashed_password="x",
        name="Buyer",
    )
    db_session.add_all([organizer, buyer])
    await db_session.flush()

    event = Event(
        organizer_id=organizer.id,
        title="Service Event",
        slug=f"test-payment-{uuid.uuid4().hex[:8]}",
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
        sold_count=quantity,
    )
    db_session.add(tier)
    await db_session.flush()

    order = Order(
        user_id=buyer.id,
        event_id=event.id,
        tier_id=tier.id,
        order_type=OrderType.PURCHASE,
        status=order_status,
        quantity=quantity,
        unit_price=unit_price,
        total_amount=unit_price * quantity,
        payment_deadline=payment_deadline,
        payment_id=payment_id,
        payment_currency="KRW",
        pg_provider="portone" if payment_id else None,
    )
    db_session.add(order)
    await db_session.flush()

    for _ in range(quantity):
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
        "organizer": organizer,
        "buyer": buyer,
        "event": event,
        "tier": tier,
        "order": order,
    }


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


@pytest.mark.asyncio
async def test_initiate_payment_success(db_session):
    bundle = await _create_order_bundle(db_session, order_status=OrderStatus.PENDING)
    svc = PaymentService(db_session)

    resp = await svc.initiate_payment(bundle["order"].id, idempotency_key="idem_1")
    assert resp.status == "payment_required"

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.PAYMENT_REQUIRED
    assert bundle["order"].payment_id is not None


@pytest.mark.asyncio
async def test_initiate_payment_keeps_longer_lottery_deadline(db_session):
    """추첨 당첨자 주문의 72시간 결제 기한을 결제창 세션(15분)으로 줄이지 않는다.

    2026-11-24 운영 상점 실결제 시험: 결제창을 연 뒤 15분이 지나 「결제 기한 지남」으로
    당첨 주문을 잃을 뻔했다. 더 늦은 기한이 있으면 그대로 두고, 없거나 더 이르면 15분을 준다.
    """
    lottery_deadline = datetime.now(timezone.utc) + timedelta(hours=72)
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_deadline=lottery_deadline,
        payment_id=None,
    )
    svc = PaymentService(db_session)

    resp = await svc.initiate_payment(bundle["order"].id, idempotency_key="idem_lottery_deadline")
    await db_session.refresh(bundle["order"])
    kept = bundle["order"].payment_deadline
    if kept.tzinfo is None:
        kept = kept.replace(tzinfo=timezone.utc)
    assert abs((kept - lottery_deadline).total_seconds()) < 2
    assert resp.payment_deadline is not None

    # 기한이 곧 끝나는 주문은 결제창 세션 15분을 받는다(기존 동작 유지).
    short = datetime.now(timezone.utc) + timedelta(minutes=1)
    bundle2 = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_deadline=short,
        payment_id=None,
    )
    await svc.initiate_payment(bundle2["order"].id, idempotency_key="idem_short_deadline")
    await db_session.refresh(bundle2["order"])
    extended = bundle2["order"].payment_deadline
    if extended.tzinfo is None:
        extended = extended.replace(tzinfo=timezone.utc)
    assert extended > short + timedelta(minutes=10)


@pytest.mark.asyncio
async def test_initiate_payment_cancelled_order(db_session):
    bundle = await _create_order_bundle(db_session, order_status=OrderStatus.CANCELLED)
    svc = PaymentService(db_session)

    with pytest.raises(ValueError):
        await svc.initiate_payment(bundle["order"].id, idempotency_key="idem_cancelled")


@pytest.mark.asyncio
async def test_initiate_payment_idempotent(db_session):
    bundle = await _create_order_bundle(db_session, order_status=OrderStatus.PENDING)
    svc = PaymentService(db_session)

    first = await svc.initiate_payment(bundle["order"].id, idempotency_key="idem_repeat")
    second = await svc.initiate_payment(bundle["order"].id, idempotency_key="idem_repeat")

    assert first.payment_id == second.payment_id
    assert first.status == "payment_required"
    assert second.status == "payment_required"


@pytest.mark.asyncio
async def test_confirm_payment_success(db_session):
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_confirm_success",
    )
    svc = PaymentService(db_session)

    resp = await svc.confirm_payment(
        bundle["order"].id,
        pg_provider="portone",
        pg_txn_id="txn_confirm_success",
        payment_id="pay_confirm_success",
        amount=bundle["order"].total_amount,
    )
    assert resp.status == "confirmed"

    tickets = (
        (
            await db_session.execute(
                select(Ticket).where(Ticket.purchase_order_id == bundle["order"].id)
            )
        )
        .scalars()
        .all()
    )
    assert all(t.status == TicketStatus.ACTIVE for t in tickets)


@pytest.mark.asyncio
async def test_confirm_payment_amount_mismatch(db_session):
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_confirm_mismatch",
    )
    svc = PaymentService(db_session)

    with pytest.raises(ValueError):
        await svc.confirm_payment(
            bundle["order"].id,
            pg_txn_id="txn_confirm_mismatch",
            payment_id="pay_confirm_mismatch",
            amount=bundle["order"].total_amount + 1.0,
        )


@pytest.mark.asyncio
async def test_confirm_payment_txn_reuse(db_session):
    bundle_1 = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_txn_reuse_1",
    )
    bundle_2 = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_txn_reuse_2",
    )
    svc = PaymentService(db_session)

    txn_id = "txn_reuse_unique"
    await svc.confirm_payment(
        bundle_1["order"].id,
        pg_txn_id=txn_id,
        payment_id="pay_txn_reuse_1",
        amount=bundle_1["order"].total_amount,
    )
    await db_session.flush()

    with pytest.raises(ValueError):
        await svc.confirm_payment(
            bundle_2["order"].id,
            pg_txn_id=txn_id,
            payment_id="pay_txn_reuse_2",
            amount=bundle_2["order"].total_amount,
        )


@pytest.mark.asyncio
async def test_authorize_payment_success(db_session):
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_authorize_success",
    )
    svc = PaymentService(db_session)

    resp = await svc.authorize_payment(
        bundle["order"].id,
        pg_txn_id="txn_authorize_success",
        payment_id="pay_authorize_success",
        amount=bundle["order"].total_amount,
    )
    assert resp.status == "authorized"


@pytest.mark.asyncio
async def test_authorize_payment_rejects_confirmed_order(db_session):
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.CONFIRMED,
        payment_id="pay_authorize_confirmed",
    )
    svc = PaymentService(db_session)

    with pytest.raises(ValueError, match="Cannot authorize payment"):
        await svc.authorize_payment(
            bundle["order"].id,
            pg_txn_id="txn_authorize_confirmed",
            payment_id="pay_authorize_confirmed",
            amount=bundle["order"].total_amount,
        )


@pytest.mark.asyncio
async def test_capture_payment_success(db_session):
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.AUTHORIZED,
        payment_id="pay_capture_success",
    )
    svc = PaymentService(db_session)

    resp = await svc.capture_payment(bundle["order"].id)
    assert resp.status == "confirmed"
    assert resp.captured_at is not None


@pytest.mark.asyncio
async def test_initiate_payment_from_payment_required_new_key_remains_valid(db_session):
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_prepare_repeat",
    )
    svc = PaymentService(db_session)

    resp = await svc.initiate_payment(bundle["order"].id, idempotency_key="idem_new_prepare")

    assert resp.status == "payment_required"


@pytest.mark.asyncio
async def test_initiate_payment_default_provider_params_none(db_session):
    """기본 provider(nicepay 아님)면 provider_params 는 None(기존 8필드 계약 무변)."""
    bundle = await _create_order_bundle(db_session, order_status=OrderStatus.PENDING)
    svc = PaymentService(db_session)

    resp = await svc.initiate_payment(bundle["order"].id, idempotency_key="idem_default_pp")

    # 전역 기본 게이트웨이는 nicepay 가 아니므로(toss/mock) provider_params 미부착.
    assert svc.gateway.provider_name != "nicepay"
    assert resp.provider_params is None



@pytest.mark.asyncio
async def test_initiate_payment_nicepay_mock_mode_is_signalled(db_session, monkeypatch):
    """상점키가 없는 개발 환경이면 provider_params.mode == "mock" — 피켓이 결제창 대신 모의 승인으로 간다.

    예전엔 이 값을 내려주지 않아 피켓이 실제 결제창을 불렀고(서명이 비어) 「나이스페이로 결제 중…」에서 멈췄다.
    운영은 설정 검증이 상점키를 강제하므로 mock 이 나올 수 없다(test_config 쪽 가드).
    """
    from app.core.config import settings
    from app.services.nicepay_gateway import NicepayGateway

    monkeypatch.setattr(settings, "NICE_MID", "nicepay00m", raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", "", raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)

    bundle = await _create_order_bundle(db_session, order_status=OrderStatus.PENDING)
    svc = PaymentService(db_session)
    svc.gateway = NicepayGateway()
    assert svc.gateway.mock_mode is True
    resp = await svc.initiate_payment(
        bundle["order"].id,
        idempotency_key="idem_nicepay_mock",
        success_url="https://www.pickket.kr/pay/success",
        fail_url="https://www.pickket.kr/pay/fail",
    )
    assert resp.provider == "nicepay"
    assert resp.provider_params is not None
    assert resp.provider_params["mode"] == "mock"
    # 결제창 폼은 그대로(서명 입력 필드에 mode 가 섞이지 않는다)
    assert "mode" not in resp.provider_params["form"]

@pytest.mark.asyncio
async def test_initiate_payment_nicepay_provider_params(db_session, monkeypatch):
    """nicepay 게이트웨이면 provider_params.form 에 payForm 필드 노출.

    - form.MID·SignData 존재(서버 계산)
    - form.ReturnURL = v2 return(NICEPAY_RETURN_URL 설정 시)
    - form.MallReserved = success_url(consumer 성공페이지)
    - js_url = 결제창 JS SDK URL
    재반환(idempotent) 경로도 metadata['prepare'] 에서 동일 재구성됨을 검증한다.
    """
    from app.core.config import settings
    from app.services.nicepay_gateway import NicepayGateway

    monkeypatch.setattr(settings, "NICE_MID", "nicepay00m", raising=False)
    monkeypatch.setattr(
        settings, "NICE_MERCHANT_KEY", "merchantkey_golden_fixed_0123456789", raising=False
    )
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    monkeypatch.setattr(
        settings, "NICEPAY_RETURN_URL",
        "https://api.pickket.kr/api/v1/payments/nice/return", raising=False,
    )

    bundle = await _create_order_bundle(db_session, order_status=OrderStatus.PENDING)
    svc = PaymentService(db_session)
    svc.gateway = NicepayGateway()
    assert svc.gateway.provider_name == "nicepay"

    success = "https://www.pickket.kr/pay/success"
    resp = await svc.initiate_payment(
        bundle["order"].id,
        idempotency_key="idem_nicepay_pp",
        success_url=success,
        fail_url="https://www.pickket.kr/pay/fail",
    )

    assert resp.provider == "nicepay"
    assert resp.provider_params is not None
    form = resp.provider_params["form"]
    assert form["MID"] == "nicepay00m"
    assert form["Moid"] == resp.payment_id
    assert form["SignData"]  # 비어있지 않음(서버 계산)
    assert form["ReturnURL"] == "https://api.pickket.kr/api/v1/payments/nice/return"
    assert form["MallReserved"] == success
    assert resp.provider_params["js_url"]
    # 상점키가 있으면 실결제 모드 — 피켓은 실제 나이스 결제창을 연다.
    assert resp.provider_params["mode"] == "live"

    # 재반환(idempotent) 경로: 저장된 payment_metadata['prepare'] 에서 동일 재구성.
    replay = await svc.initiate_payment(
        bundle["order"].id,
        idempotency_key="idem_nicepay_pp",
        success_url=success,
        fail_url="https://www.pickket.kr/pay/fail",
    )
    assert replay.provider_params is not None
    assert replay.provider_params["form"]["MID"] == "nicepay00m"
    assert replay.provider_params["form"]["MallReserved"] == success
    assert replay.provider_params["form"]["ReturnURL"] == form["ReturnURL"]


@pytest.mark.asyncio
async def test_nicepay_confirm_sets_payment_method_from_prepared(db_session, monkeypatch):
    """T1-1 회귀: 나이스 주문 confirm 후 order.payment_method 가 NULL 이 아니어야 한다.

    구형 승인응답 raw(대문자 KV)에는 payMethod 필드가 없다 → prepare 시 사용자가 고른
    PayMethod(payment_metadata['prepare']['PayMethod'])로 정규화돼야 한다(감사 결함 교정).
    mock 모드에서 verify_payment 는 payMethod 없는 raw 를 반환하므로 폴백 경로를 탄다.
    """
    from app.core.config import settings
    from app.services.nicepay_gateway import NicepayGateway

    # MerchantKey 미설정 → mock 모드(실 HTTP 없이 승인). PayMethod 폴백은 그대로 동작.
    monkeypatch.setattr(settings, "NICE_MID", "nicepay00m", raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", "", raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", True, raising=False)

    bundle = await _create_order_bundle(db_session, order_status=OrderStatus.PENDING)
    svc = PaymentService(db_session)
    svc.gateway = NicepayGateway()
    assert svc.gateway.provider_name == "nicepay"

    # prepare 에 사용자 선택 결제수단 vbank 전달 → payForm PayMethod=VBANK 박제.
    resp = await svc.initiate_payment(
        bundle["order"].id,
        idempotency_key="idem_nice_pm",
        success_url="https://www.pickket.kr/pay/success",
        fail_url="https://www.pickket.kr/pay/fail",
        pay_method="vbank",
    )
    assert resp.provider_params["form"]["PayMethod"] == "VBANK"

    # confirm(mock 승인) — 승인응답 raw 에 payMethod 없음 → prepared PayMethod 로 정규화.
    await svc.confirm_payment(
        bundle["order"].id,
        pg_provider="nicepay",
        pg_txn_id="txn_nice_pm",
        payment_id=resp.payment_id,
        amount=bundle["order"].total_amount,
    )
    await db_session.refresh(bundle["order"])
    # NULL 이 아니라 vbank 로 정규화됐는지(핵심 회귀).
    assert bundle["order"].payment_method == "vbank"


@pytest.mark.asyncio
async def test_capture_payment_wrong_status(db_session):
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PENDING,
        payment_id="pay_capture_wrong",
    )
    svc = PaymentService(db_session)

    with pytest.raises(ValueError):
        await svc.capture_payment(bundle["order"].id)


@pytest.mark.asyncio
async def test_void_payment_success(db_session):
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.AUTHORIZED,
        quantity=2,
        payment_id="pay_void_success",
    )
    svc = PaymentService(db_session)

    resp = await svc.void_payment(bundle["order"].id, reason="void_for_test")
    assert resp.status == "cancelled"

    await db_session.refresh(bundle["tier"])
    assert bundle["tier"].sold_count == 0

    tickets = (
        (
            await db_session.execute(
                select(Ticket).where(Ticket.purchase_order_id == bundle["order"].id)
            )
        )
        .scalars()
        .all()
    )
    assert all(t.status == TicketStatus.CANCELLED for t in tickets)


@pytest.mark.asyncio
async def test_process_expired_orders(db_session):
    past_deadline = datetime.now(timezone.utc) - timedelta(minutes=10)
    future_deadline = datetime.now(timezone.utc) + timedelta(minutes=10)

    expired_bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_deadline=past_deadline,
        payment_id="pay_expired_1",
    )
    _ = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_deadline=future_deadline,
        payment_id="pay_not_expired",
    )
    svc = PaymentService(db_session)

    cancelled_count = await svc.process_expired_orders()
    assert cancelled_count == 1

    await db_session.refresh(expired_bundle["order"])
    assert expired_bundle["order"].status == OrderStatus.EXPIRED


@pytest.mark.asyncio
async def test_webhook_paid_confirms(db_session):
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_webhook_paid",
    )
    svc = PaymentService(db_session)

    payload = {
        "id": "evt_webhook_paid",
        "type": "payment.paid",
        "data": {
            "paymentId": "pay_webhook_paid",
            "transactionId": "txn_webhook_paid",
            "status": "paid",
            "amount": {"total": bundle["order"].total_amount},
        },
    }
    await svc.handle_portone_webhook(raw_body=json.dumps(payload).encode("utf-8"))

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED


@pytest.mark.asyncio
async def test_webhook_failed_cancels(db_session):
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_webhook_failed",
    )
    svc = PaymentService(db_session)

    payload = {
        "id": "evt_webhook_failed",
        "type": "payment.failed",
        "data": {
            "paymentId": "pay_webhook_failed",
            "transactionId": "txn_webhook_failed",
            "status": "failed",
            "amount": {"total": bundle["order"].total_amount},
        },
    }
    await svc.handle_portone_webhook(raw_body=json.dumps(payload).encode("utf-8"))

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CANCELLED


@pytest.mark.asyncio
async def test_webhook_duplicate_skipped(db_session):
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_webhook_dup",
    )
    bundle["order"].payment_webhook_event_id = "evt_webhook_dup"
    await db_session.flush()
    svc = PaymentService(db_session)

    payload = {
        "id": "evt_webhook_dup",
        "type": "payment.paid",
        "data": {
            "paymentId": "pay_webhook_dup",
            "transactionId": "txn_webhook_dup",
            "status": "paid",
            "amount": {"total": bundle["order"].total_amount},
        },
    }
    await svc.handle_portone_webhook(raw_body=json.dumps(payload).encode("utf-8"))

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.PAYMENT_REQUIRED


# ═══════════════════════════════════════════════════════════════════════════
# 추가 테스트: cancel_order, expire_pending_orders, confirm_payment edge cases,
# initiate_refund, webhook edge cases
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_cancel_order_from_pending(db_session):
    """cancel_order — PENDING 주문을 직접 취소하면 CANCELLED로 전환되고 sold_count 복원."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PENDING,
        quantity=3,
    )
    svc = PaymentService(db_session)
    await svc.cancel_order(bundle["order"].id, target_status=OrderStatus.CANCELLED)

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CANCELLED
    assert bundle["order"].payment_failed_at is not None
    assert "cancelled" in (bundle["order"].payment_failed_reason or "")

    await db_session.refresh(bundle["tier"])
    assert bundle["tier"].sold_count == 0

    tickets = (
        (
            await db_session.execute(
                select(Ticket).where(Ticket.purchase_order_id == bundle["order"].id)
            )
        )
        .scalars()
        .all()
    )
    assert all(t.status == TicketStatus.CANCELLED for t in tickets)


@pytest.mark.asyncio
async def test_cancel_order_from_payment_required(db_session):
    """cancel_order — PAYMENT_REQUIRED → EXPIRED 전환."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_cancel_pr",
    )
    svc = PaymentService(db_session)
    await svc.cancel_order(bundle["order"].id, target_status=OrderStatus.EXPIRED)

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.EXPIRED
    assert "expired" in (bundle["order"].payment_failed_reason or "").lower()


@pytest.mark.asyncio
async def test_cancel_order_fraud_recording_failure(db_session, monkeypatch):
    """cancel_order — fraud record_payment_failure 실패 시에도 취소는 정상 진행."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PENDING,
    )

    async def _failing_record(user_id):
        raise RuntimeError("Redis down")

    import app.services.fraud_detector as fraud_mod
    monkeypatch.setattr(fraud_mod, "record_payment_failure", _failing_record)

    svc = PaymentService(db_session)
    await svc.cancel_order(bundle["order"].id, target_status=OrderStatus.CANCELLED)

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CANCELLED


@pytest.mark.asyncio
async def test_cancel_order_not_found(db_session):
    """cancel_order — 존재하지 않는 주문 ID로 호출 시 ValueError."""
    svc = PaymentService(db_session)
    fake_id = uuid.uuid4()
    with pytest.raises(ValueError, match="not found"):
        await svc.cancel_order(fake_id)


@pytest.mark.asyncio
async def test_cancel_order_invalid_transition(db_session):
    """cancel_order — 이미 CONFIRMED 상태인 주문을 CANCELLED로 전환 시 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.CONFIRMED,
        payment_id="pay_cancel_confirmed",
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="Invalid order status transition"):
        await svc.cancel_order(bundle["order"].id, target_status=OrderStatus.CANCELLED)


@pytest.mark.asyncio
async def test_expire_pending_orders_multiple(db_session):
    """expire_pending_orders — 복수 만료 주문 처리, 미만료 주문 미처리."""
    past = datetime.now(timezone.utc) - timedelta(minutes=30)
    future = datetime.now(timezone.utc) + timedelta(hours=1)

    b1 = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_deadline=past,
        payment_id="pay_exp_multi_1",
    )
    b2 = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_deadline=past - timedelta(minutes=5),
        payment_id="pay_exp_multi_2",
    )
    b3 = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_deadline=future,
        payment_id="pay_exp_multi_3",
    )
    svc = PaymentService(db_session)
    count = await svc.process_expired_orders()
    assert count == 2

    await db_session.refresh(b1["order"])
    await db_session.refresh(b2["order"])
    await db_session.refresh(b3["order"])
    assert b1["order"].status == OrderStatus.EXPIRED
    assert b2["order"].status == OrderStatus.EXPIRED
    assert b3["order"].status == OrderStatus.PAYMENT_REQUIRED


@pytest.mark.asyncio
async def test_expire_pending_orders_none_expired(db_session):
    """expire_pending_orders — 만료 주문이 없으면 0 반환."""
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_deadline=future,
        payment_id="pay_exp_none",
    )
    svc = PaymentService(db_session)
    count = await svc.process_expired_orders()
    assert count == 0


@pytest.mark.asyncio
async def test_confirm_payment_already_confirmed_same_txn(db_session):
    """confirm_payment — 이미 CONFIRMED인 주문을 같은 txn_id로 재확인하면 멱등 응답."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_double_confirm",
    )
    svc = PaymentService(db_session)

    resp1 = await svc.confirm_payment(
        bundle["order"].id,
        pg_txn_id="txn_double_confirm",
        payment_id="pay_double_confirm",
        amount=bundle["order"].total_amount,
    )
    assert resp1.status == "confirmed"

    # Second call with same txn_id → idempotent
    resp2 = await svc.confirm_payment(
        bundle["order"].id,
        pg_txn_id="txn_double_confirm",
        payment_id="pay_double_confirm",
        amount=bundle["order"].total_amount,
    )
    assert resp2.status == "confirmed"
    assert resp2.pg_transaction_id == "txn_double_confirm"


@pytest.mark.asyncio
async def test_confirm_payment_already_confirmed_different_txn(db_session):
    """confirm_payment — CONFIRMED 주문에 다른 txn_id로 확인 시 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_double_diff",
    )
    svc = PaymentService(db_session)

    await svc.confirm_payment(
        bundle["order"].id,
        pg_txn_id="txn_original",
        payment_id="pay_double_diff",
        amount=bundle["order"].total_amount,
    )

    with pytest.raises(ValueError, match="Cannot confirm"):
        await svc.confirm_payment(
            bundle["order"].id,
            pg_txn_id="txn_different",
            payment_id="pay_double_diff",
            amount=bundle["order"].total_amount,
        )


@pytest.mark.asyncio
async def test_confirm_payment_cancelled_order(db_session):
    """confirm_payment — CANCELLED 주문 확인 시 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.CANCELLED,
        payment_id="pay_confirm_cancelled",
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="Cannot confirm"):
        await svc.confirm_payment(
            bundle["order"].id,
            pg_txn_id="txn_nope",
            payment_id="pay_confirm_cancelled",
            amount=bundle["order"].total_amount,
        )


@pytest.mark.asyncio
async def test_confirm_payment_expired_order(db_session):
    """confirm_payment — EXPIRED 주문 확인 시 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.EXPIRED,
        payment_id="pay_confirm_expired",
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="Cannot confirm"):
        await svc.confirm_payment(
            bundle["order"].id,
            pg_txn_id="txn_expired",
            payment_id="pay_confirm_expired",
            amount=bundle["order"].total_amount,
        )


@pytest.mark.asyncio
async def test_confirm_payment_deadline_expired(db_session):
    """confirm_payment — 결제 마감 시간이 지난 주문 확인 시 ValueError."""
    past_deadline = datetime.now(timezone.utc) - timedelta(minutes=30)
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_deadline=past_deadline,
        payment_id="pay_deadline_past",
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="deadline has expired"):
        await svc.confirm_payment(
            bundle["order"].id,
            pg_txn_id="txn_late",
            payment_id="pay_deadline_past",
            amount=bundle["order"].total_amount,
        )


@pytest.mark.asyncio
async def test_confirm_payment_payment_id_mismatch(db_session):
    """confirm_payment — 주문의 payment_id와 다른 payment_id 전달 시 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_id_original",
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="Payment ID mismatch"):
        await svc.confirm_payment(
            bundle["order"].id,
            pg_txn_id="txn_mismatch_id",
            payment_id="pay_id_different",
            amount=bundle["order"].total_amount,
        )


@pytest.mark.asyncio
async def test_confirm_payment_fraud_block(db_session, monkeypatch):
    """confirm_payment — 사기 탐지가 block 판정 시 ValueError."""
    from app.services.fraud_detector import FraudScore

    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_fraud_block",
    )

    async def _block_fraud(*, db, order_id, user_id, amount, card_hash=None):
        return FraudScore(
            order_id=order_id,
            user_id=user_id,
            total_score=90,
            card_velocity_score=40,
            amount_anomaly_score=30,
            geo_velocity_score=10,
            device_score=5,
            failure_pattern_score=5,
            reasons=["test_block"],
        )

    import app.services.payment_service as ps_mod
    monkeypatch.setattr(ps_mod, "analyze_fraud", _block_fraud)

    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="blocked by fraud"):
        await svc.confirm_payment(
            bundle["order"].id,
            pg_txn_id="txn_fraud_block",
            payment_id="pay_fraud_block",
            amount=bundle["order"].total_amount,
        )


@pytest.mark.asyncio
async def test_confirm_payment_fraud_review_allows(db_session, monkeypatch):
    """confirm_payment — 사기 탐지 review 판정은 결제 진행 허용."""
    from app.services.fraud_detector import FraudScore

    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_fraud_review",
    )

    async def _review_fraud(*, db, order_id, user_id, amount, card_hash=None):
        return FraudScore(
            order_id=order_id,
            user_id=user_id,
            total_score=55,
            card_velocity_score=20,
            amount_anomaly_score=15,
            geo_velocity_score=10,
            device_score=5,
            failure_pattern_score=5,
            reasons=["test_review"],
        )

    import app.services.payment_service as ps_mod
    monkeypatch.setattr(ps_mod, "analyze_fraud", _review_fraud)

    svc = PaymentService(db_session)
    resp = await svc.confirm_payment(
        bundle["order"].id,
        pg_txn_id="txn_fraud_review",
        payment_id="pay_fraud_review",
        amount=bundle["order"].total_amount,
    )
    assert resp.status == "confirmed"


@pytest.mark.asyncio
async def test_confirm_payment_fraud_exception_allows(db_session, monkeypatch):
    """confirm_payment — 사기 탐지 자체가 예외를 던져도 결제는 진행."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_fraud_err",
    )

    async def _broken_fraud(*, db, order_id, user_id, amount, card_hash=None):
        raise RuntimeError("Fraud service is down")

    import app.services.payment_service as ps_mod
    monkeypatch.setattr(ps_mod, "analyze_fraud", _broken_fraud)

    svc = PaymentService(db_session)
    resp = await svc.confirm_payment(
        bundle["order"].id,
        pg_txn_id="txn_fraud_err",
        payment_id="pay_fraud_err",
        amount=bundle["order"].total_amount,
    )
    assert resp.status == "confirmed"


@pytest.mark.asyncio
async def test_initiate_refund_full(db_session):
    """initiate_refund — CONFIRMED 주문 전체 환불."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.CONFIRMED,
        payment_id="pay_refund_full",
        quantity=2,
        unit_price=100.0,
    )
    svc = PaymentService(db_session)
    result = await svc.initiate_refund(
        bundle["order"].id,
        reason="고객 변심",
    )
    assert result["status"] == "refunded"
    assert result["refund_amount"] == 200.0

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.REFUNDED

    # 티켓도 취소됨
    tickets = (
        (
            await db_session.execute(
                select(Ticket).where(Ticket.purchase_order_id == bundle["order"].id)
            )
        )
        .scalars()
        .all()
    )
    assert all(t.status == TicketStatus.CANCELLED for t in tickets)


@pytest.mark.asyncio
async def test_initiate_refund_partial(db_session):
    """initiate_refund — 부분 환불은 주문 상태를 CONFIRMED으로 유지."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.CONFIRMED,
        payment_id="pay_refund_partial",
        quantity=1,
        unit_price=200.0,
    )
    svc = PaymentService(db_session)
    result = await svc.initiate_refund(
        bundle["order"].id,
        reason="부분 환불",
        amount=50.0,
    )
    assert result["refund_amount"] == 50.0
    # 부분 환불은 CONFIRMED 유지
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED


@pytest.mark.asyncio
async def test_initiate_refund_already_refunded(db_session):
    """initiate_refund — 이미 환불된 주문 재환불 시 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.REFUNDED,
        payment_id="pay_refund_dup",
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="이미 환불된"):
        await svc.initiate_refund(bundle["order"].id, reason="test")


@pytest.mark.asyncio
async def test_initiate_refund_invalid_status(db_session):
    """initiate_refund — PENDING 주문 환불 시 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PENDING,
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="Cannot refund"):
        await svc.initiate_refund(bundle["order"].id, reason="test")


@pytest.mark.asyncio
async def test_initiate_refund_used_ticket_blocks(db_session):
    """initiate_refund — 체크인 완료 티켓이 있으면 환불 차단."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.CONFIRMED,
        payment_id="pay_refund_used",
    )
    # 티켓 상태를 USED로 변경
    tickets = (
        (
            await db_session.execute(
                select(Ticket).where(Ticket.purchase_order_id == bundle["order"].id)
            )
        )
        .scalars()
        .all()
    )
    for t in tickets:
        t.status = TicketStatus.USED
    await db_session.flush()

    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="already checked in"):
        await svc.initiate_refund(bundle["order"].id, reason="test")


@pytest.mark.asyncio
async def test_initiate_refund_negative_amount(db_session):
    """initiate_refund — 환불 금액이 0 이하이면 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.CONFIRMED,
        payment_id="pay_refund_neg",
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="greater than 0"):
        await svc.initiate_refund(bundle["order"].id, reason="test", amount=-10.0)


@pytest.mark.asyncio
async def test_initiate_refund_exceeds_balance(db_session):
    """initiate_refund — 환불 금액이 잔여 환불 가능액 초과 시 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.CONFIRMED,
        payment_id="pay_refund_exceed",
        unit_price=100.0,
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="exceeds refundable"):
        await svc.initiate_refund(
            bundle["order"].id, reason="test", amount=200.0
        )


@pytest.mark.asyncio
async def test_initiate_refund_no_payment_id(db_session):
    """initiate_refund — 전체 환불인데 payment_id 없으면 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.CONFIRMED,
        payment_id=None,
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="Missing payment_id"):
        await svc.initiate_refund(bundle["order"].id, reason="test")


@pytest.mark.asyncio
async def test_void_payment_wrong_status(db_session):
    """void_payment — AUTHORIZED가 아닌 주문에서 void 시 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_void_wrong",
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="Cannot void"):
        await svc.void_payment(bundle["order"].id, reason="test")


@pytest.mark.asyncio
async def test_void_payment_no_payment_id(db_session):
    """void_payment — payment_id 없으면 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.AUTHORIZED,
        payment_id=None,
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="Missing payment_id"):
        await svc.void_payment(bundle["order"].id, reason="test")


@pytest.mark.asyncio
async def test_authorize_payment_amount_mismatch(db_session):
    """authorize_payment — 금액 불일치 시 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_auth_mismatch",
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="Amount mismatch"):
        await svc.authorize_payment(
            bundle["order"].id,
            pg_txn_id="txn_auth_mismatch",
            payment_id="pay_auth_mismatch",
            amount=bundle["order"].total_amount + 999.0,
        )


@pytest.mark.asyncio
async def test_authorize_payment_payment_id_mismatch(db_session):
    """authorize_payment — payment_id 불일치 시 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_auth_pid_orig",
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="Payment ID mismatch"):
        await svc.authorize_payment(
            bundle["order"].id,
            pg_txn_id="txn_auth_pid",
            payment_id="pay_auth_pid_diff",
            amount=bundle["order"].total_amount,
        )


@pytest.mark.asyncio
async def test_authorize_payment_idempotent_same_txn(db_session):
    """authorize_payment — 이미 AUTHORIZED인 주문에 같은 txn_id → 멱등 응답."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_auth_idem",
    )
    svc = PaymentService(db_session)

    resp1 = await svc.authorize_payment(
        bundle["order"].id,
        pg_txn_id="txn_auth_idem",
        payment_id="pay_auth_idem",
        amount=bundle["order"].total_amount,
    )
    assert resp1.status == "authorized"

    resp2 = await svc.authorize_payment(
        bundle["order"].id,
        pg_txn_id="txn_auth_idem",
        payment_id="pay_auth_idem",
        amount=bundle["order"].total_amount,
    )
    assert resp2.status == "authorized"


@pytest.mark.asyncio
async def test_authorize_payment_already_auth_different_txn(db_session):
    """authorize_payment — AUTHORIZED 주문에 다른 txn_id → ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_auth_diff_txn",
    )
    svc = PaymentService(db_session)

    await svc.authorize_payment(
        bundle["order"].id,
        pg_txn_id="txn_auth_first",
        payment_id="pay_auth_diff_txn",
        amount=bundle["order"].total_amount,
    )

    with pytest.raises(ValueError, match="already authorized"):
        await svc.authorize_payment(
            bundle["order"].id,
            pg_txn_id="txn_auth_second",
            payment_id="pay_auth_diff_txn",
            amount=bundle["order"].total_amount,
        )


@pytest.mark.asyncio
async def test_authorize_payment_expired_order(db_session):
    """authorize_payment — EXPIRED 주문에서 authorize 시도 시 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.EXPIRED,
        payment_id="pay_auth_expired",
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="Cannot authorize"):
        await svc.authorize_payment(
            bundle["order"].id,
            pg_txn_id="txn_auth_expired",
            payment_id="pay_auth_expired",
            amount=bundle["order"].total_amount,
        )


@pytest.mark.asyncio
async def test_authorize_payment_txn_reuse(db_session):
    """authorize_payment — pg_transaction_id가 다른 주문에서 이미 사용된 경우 ValueError."""
    bundle_1 = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_auth_reuse_1",
    )
    bundle_2 = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_auth_reuse_2",
    )
    svc = PaymentService(db_session)

    txn_id = "txn_auth_reuse_unique"
    await svc.authorize_payment(
        bundle_1["order"].id,
        pg_txn_id=txn_id,
        payment_id="pay_auth_reuse_1",
        amount=bundle_1["order"].total_amount,
    )
    await db_session.flush()

    with pytest.raises(ValueError, match="already been used"):
        await svc.authorize_payment(
            bundle_2["order"].id,
            pg_txn_id=txn_id,
            payment_id="pay_auth_reuse_2",
            amount=bundle_2["order"].total_amount,
        )


@pytest.mark.asyncio
async def test_capture_payment_already_confirmed(db_session):
    """capture_payment — 이미 CONFIRMED + captured_at 설정된 주문 → 멱등 응답."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.CONFIRMED,
        payment_id="pay_capture_idem",
    )
    bundle["order"].captured_at = datetime.now(timezone.utc)
    await db_session.flush()

    svc = PaymentService(db_session)
    resp = await svc.capture_payment(bundle["order"].id)
    assert resp.status == "confirmed"


@pytest.mark.asyncio
async def test_capture_payment_no_payment_id(db_session):
    """capture_payment — AUTHORIZED이지만 payment_id 없으면 ValueError."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.AUTHORIZED,
        payment_id=None,
    )
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="Missing payment_id"):
        await svc.capture_payment(bundle["order"].id)


@pytest.mark.asyncio
async def test_webhook_authorized_event(db_session):
    """webhook — authorized 이벤트 수신 시 주문 AUTHORIZED 전환."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_webhook_auth",
    )
    svc = PaymentService(db_session)

    payload = {
        "id": "evt_webhook_auth",
        "type": "payment.authorized",
        "data": {
            "paymentId": "pay_webhook_auth",
            "transactionId": "txn_webhook_auth",
            "status": "authorized",
            "amount": {"total": bundle["order"].total_amount},
        },
    }
    result = await svc.handle_portone_webhook(raw_body=json.dumps(payload).encode("utf-8"))
    # authorized webhook은 propagation hint를 반환하지 않음
    assert result is None

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.AUTHORIZED


@pytest.mark.asyncio
async def test_webhook_paid_from_authorized(db_session):
    """webhook — AUTHORIZED 상태에서 paid 이벤트 → capture_payment 경로."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.AUTHORIZED,
        payment_id="pay_webhook_cap",
    )
    svc = PaymentService(db_session)

    payload = {
        "id": "evt_webhook_cap",
        "type": "payment.paid",
        "data": {
            "paymentId": "pay_webhook_cap",
            "transactionId": "txn_webhook_cap",
            "status": "paid",
            "amount": {"total": bundle["order"].total_amount},
        },
    }
    result = await svc.handle_portone_webhook(raw_body=json.dumps(payload).encode("utf-8"))
    assert result is not None
    assert len(result) == 1
    assert result[0]["event"] == "order.payment.confirmed"

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED


@pytest.mark.asyncio
async def test_webhook_failed_from_authorized(db_session):
    """webhook — AUTHORIZED 상태에서 failed 이벤트 → void_payment 경로."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.AUTHORIZED,
        payment_id="pay_webhook_void",
        quantity=1,
    )
    svc = PaymentService(db_session)

    payload = {
        "id": "evt_webhook_void",
        "type": "payment.failed",
        "data": {
            "paymentId": "pay_webhook_void",
            "transactionId": "txn_webhook_void",
            "status": "failed",
            "amount": {"total": bundle["order"].total_amount},
        },
    }
    result = await svc.handle_portone_webhook(raw_body=json.dumps(payload).encode("utf-8"))
    assert result is not None
    assert result[0]["event"] == "order.payment.failed"

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CANCELLED


@pytest.mark.asyncio
async def test_webhook_cancelled_from_pending(db_session):
    """webhook — PAYMENT_REQUIRED 상태에서 cancelled 이벤트 → cancel_order 경로."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_webhook_cancel",
    )
    svc = PaymentService(db_session)

    payload = {
        "id": "evt_webhook_cancel",
        "type": "payment.cancelled",
        "data": {
            "paymentId": "pay_webhook_cancel",
            "transactionId": None,
            "status": "cancelled",
            "amount": {"total": bundle["order"].total_amount},
        },
    }
    result = await svc.handle_portone_webhook(raw_body=json.dumps(payload).encode("utf-8"))
    assert result is not None
    assert result[0]["event"] == "order.cancelled"

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CANCELLED


@pytest.mark.asyncio
async def test_webhook_unknown_status(db_session):
    """webhook — 알 수 없는 status → metadata만 저장, propagation 없음."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_webhook_unknown",
    )
    svc = PaymentService(db_session)

    payload = {
        "id": "evt_webhook_unknown",
        "type": "payment.refund_pending",
        "data": {
            "paymentId": "pay_webhook_unknown",
            "transactionId": None,
            "status": "refund_pending",
            "amount": {"total": bundle["order"].total_amount},
        },
    }
    result = await svc.handle_portone_webhook(raw_body=json.dumps(payload).encode("utf-8"))
    assert result is None

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.PAYMENT_REQUIRED


@pytest.mark.asyncio
async def test_webhook_no_payment_id(db_session):
    """webhook — paymentId가 없는 payload → None 반환."""
    svc = PaymentService(db_session)

    payload = {
        "id": "evt_no_pid",
        "type": "payment.test",
        "data": {
            "paymentId": None,
            "status": "test",
        },
    }
    result = await svc.handle_portone_webhook(raw_body=json.dumps(payload).encode("utf-8"))
    assert result is None


@pytest.mark.asyncio
async def test_webhook_order_not_found(db_session):
    """webhook — payment_id에 매칭되는 주문이 없으면 None 반환."""
    svc = PaymentService(db_session)

    payload = {
        "id": "evt_orphan",
        "type": "payment.paid",
        "data": {
            "paymentId": "pay_orphan_not_exist",
            "transactionId": "txn_orphan",
            "status": "paid",
            "amount": {"total": 100},
        },
    }
    result = await svc.handle_portone_webhook(raw_body=json.dumps(payload).encode("utf-8"))
    assert result is None


@pytest.mark.asyncio
async def test_webhook_invalid_json(db_session):
    """webhook — JSON 파싱 실패 시 ValueError."""
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="Invalid webhook payload"):
        await svc.handle_portone_webhook(raw_body=b"not-json{{")


@pytest.mark.asyncio
async def test_webhook_failed_from_confirmed_ignored(db_session):
    """webhook — CONFIRMED 주문에서 failed 이벤트 → 무시 (None 반환)."""
    bundle = await _create_order_bundle(
        db_session,
        order_status=OrderStatus.CONFIRMED,
        payment_id="pay_webhook_confirmed_fail",
    )
    svc = PaymentService(db_session)

    payload = {
        "id": "evt_confirmed_fail",
        "type": "payment.failed",
        "data": {
            "paymentId": "pay_webhook_confirmed_fail",
            "transactionId": "txn_confirmed_fail",
            "status": "failed",
            "amount": {"total": bundle["order"].total_amount},
        },
    }
    result = await svc.handle_portone_webhook(raw_body=json.dumps(payload).encode("utf-8"))
    assert result is None

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED


@pytest.mark.asyncio
async def test_get_order_for_update_not_found(db_session):
    """_get_order_for_update — 존재하지 않는 주문 ID → ValueError."""
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="not found"):
        await svc._get_order_for_update(uuid.uuid4())


@pytest.mark.asyncio
async def test_void_payment_not_found(db_session):
    """void_payment — 존재하지 않는 주문 ID → ValueError."""
    svc = PaymentService(db_session)
    with pytest.raises(ValueError, match="not found"):
        await svc.void_payment(uuid.uuid4(), reason="test")


# ── T15: BC 자동할인 주문의 카드사 재검증 ────────────────────────────────────

class _Order:
    """_enforce_card_discount_issuer 단위검증용 최소 주문 스텁."""

    def __init__(self, meta):
        self.id = uuid.uuid4()
        self.user_id = uuid.uuid4()
        self.event_id = uuid.uuid4()
        self.payment_id = "pay-1"
        self.payment_metadata = meta


class _Verified:
    def __init__(self, raw):
        self.raw = raw


def _svc_with_spy(monkeypatch, voided):
    """void_authorization 호출을 기록하는 서비스 인스턴스."""
    from app.services.payment_service import PaymentService

    svc = PaymentService.__new__(PaymentService)

    class _GW:
        async def void_authorization(self, **kw):
            voided.append(kw)
            return type("R", (), {"transaction_id": "void-1", "raw": {}})()

    monkeypatch.setattr(PaymentService, "_gateway_for", lambda self, order: _GW(), raising=False)
    monkeypatch.setattr(
        "app.services.payment_service.write_audit_log",
        _noop_audit,
        raising=False,
    )
    svc.session = None
    return svc


async def _noop_audit(*a, **k):
    return None


@pytest.mark.asyncio
async def test_t15_rejects_when_card_issuer_mismatch(monkeypatch):
    """🔴 BC 할인가로 승인됐는데 실제 카드사가 다르면 **확정하지 않고 승인 취소**한다.

    "확정은 하고 정산에서 잡자" 로 흘리면 그대로 손실이다 — 확정된 주문은 되돌리기 어렵고
    티켓까지 나가면 회수가 사실상 불가능하다.
    """
    voided: list = []
    svc = _svc_with_spy(monkeypatch, voided)
    order = _Order({"card_discount": {"card": "BC", "card_code": "01"}})

    with pytest.raises(ValueError, match="할인"):
        await svc._enforce_card_discount_issuer(order, _Verified({"CardCode": "04"}))

    assert len(voided) == 1, "승인 취소가 호출되지 않았다 — 돈이 남는다"


@pytest.mark.asyncio
async def test_t15_rejects_when_card_issuer_unknown(monkeypatch):
    """🔴 fail-closed — 카드사를 **확인하지 못해도** 확정하지 않는다.

    실키 미발급이라 응답 필드명이 확정되지 않았는데 "못 읽었으니 통과" 로 두면
    할인 우회가 조용히 성립한다.
    """
    voided: list = []
    svc = _svc_with_spy(monkeypatch, voided)
    order = _Order({"card_discount": {"card": "BC", "card_code": "01"}})

    with pytest.raises(ValueError):
        await svc._enforce_card_discount_issuer(order, _Verified({"TID": "x"}))

    assert len(voided) == 1


@pytest.mark.asyncio
async def test_t15_passes_when_card_issuer_matches(monkeypatch):
    """BC 로 승인됐으면 통과하고 카드사 정보를 주문 메타에 남긴다(정산 대사용)."""
    voided: list = []
    svc = _svc_with_spy(monkeypatch, voided)
    order = _Order({"card_discount": {"card": "BC", "card_code": "01"}})

    await svc._enforce_card_discount_issuer(order, _Verified({"CardCode": "01", "CardName": "비씨"}))

    assert voided == []
    assert order.payment_metadata["card_issuer"] == {"code": "01", "name": "비씨"}


@pytest.mark.asyncio
async def test_t15_skips_non_discount_orders(monkeypatch):
    """카드사 할인이 안 걸린 일반 주문은 검증 대상이 아니다(현행 동작 불변)."""
    voided: list = []
    svc = _svc_with_spy(monkeypatch, voided)
    order = _Order({})

    await svc._enforce_card_discount_issuer(order, _Verified({}))
    assert voided == []


# ── 🔴 T15 배선 검증 — 위 단위테스트가 잡지 못하는 것 ────────────────────────
#
# 위 4건은 `_enforce_card_discount_issuer` 를 **직접** 호출한다. 그래서 감사 뮤테이션(g)
# — confirm_payment/authorize_payment 에서 그 호출을 **삭제** — 를 걸어도 전건 그린이었다.
# 함수가 옳게 동작한다는 증명과, 그 함수가 실제 결제 경로에 **연결돼 있다**는 증명은
# 다른 명제다. 아래 2건이 후자를 담당한다. 호출을 지우면 여기서 죽는다.


async def _bundle_with_card_discount(db_session, *, order_status, payment_id):
    """BC 할인 메타가 박힌 주문 — 승인 응답 카드사가 BC 가 아니면 확정되면 안 된다."""
    bundle = await _create_order_bundle(
        db_session, order_status=order_status, payment_id=payment_id
    )
    order = bundle["order"]
    # card_code "99" = 어떤 실제 카드사와도 일치하지 않는 값. mock 승인이 카드사를
    # 무엇으로 내려주든(미상이면 fail-closed, "01" 이면 불일치) 확정은 거부돼야 한다.
    order.payment_metadata = {
        **(order.payment_metadata or {}),
        "card_discount": {"card": "BC", "card_code": "99", "rate": 10},
    }
    await db_session.flush()
    return bundle


@pytest.mark.asyncio
async def test_t15_is_wired_into_confirm_payment(db_session):
    """🔴 확정 경로에 T15 가 **연결**돼 있다 — 호출을 지우면 이 테스트가 죽는다."""
    bundle = await _bundle_with_card_discount(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_t15_wired_confirm",
    )
    svc = PaymentService(db_session)

    with pytest.raises(ValueError, match="카드사"):
        await svc.confirm_payment(
            bundle["order"].id,
            pg_txn_id="txn_t15_wired_confirm",
            payment_id="pay_t15_wired_confirm",
            amount=bundle["order"].total_amount,
        )

    # 확정되지 않았고 티켓도 나가지 않았는지 — 예외만으로는 부족하다.
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status != OrderStatus.CONFIRMED
    tickets = (
        (
            await db_session.execute(
                select(Ticket).where(Ticket.purchase_order_id == bundle["order"].id)
            )
        )
        .scalars()
        .all()
    )
    assert all(t.status != TicketStatus.ACTIVE for t in tickets), "확정 거부인데 티켓이 나갔다"


@pytest.mark.asyncio
async def test_t15_is_wired_into_authorize_payment(db_session):
    """🔴 사전승인 경로에도 T15 가 연결돼 있다 — capture 로 넘어가면 이미 늦다."""
    bundle = await _bundle_with_card_discount(
        db_session,
        order_status=OrderStatus.PAYMENT_REQUIRED,
        payment_id="pay_t15_wired_auth",
    )
    svc = PaymentService(db_session)

    with pytest.raises(ValueError, match="카드사"):
        await svc.authorize_payment(
            bundle["order"].id,
            pg_txn_id="txn_t15_wired_auth",
            payment_id="pay_t15_wired_auth",
            amount=bundle["order"].total_amount,
        )

    await db_session.refresh(bundle["order"])
    assert bundle["order"].status != OrderStatus.AUTHORIZED


# ── 🔴 T14 해석기 — 여기가 fail-open 이면 T15 는 존재하지 않는 것과 같다 ────────
#
# `_resolve_order_card_discount` 가 None 을 돌려주면 payment_metadata 에 card_discount 가
# 안 남고, T15 는 조기 return 한다 → **할인은 나가고 카드 검증은 0**. 즉 이 함수의
# 매칭 실패는 조용한 fail-open 이다. 설정 오타·대소문자로 그렇게 되지 않는지 고정한다.


async def _order_with_discount_code(db_session, *, code: str, card_discounts):
    """할인코드가 실제로 적용된 주문(order_items.discount_code_id) + 이벤트 설정."""
    from decimal import Decimal

    from app.models.discount_code import DiscountCode, DiscountCodeType
    from app.models.order_item import OrderItem

    bundle = await _create_order_bundle(db_session, order_status=OrderStatus.PENDING)
    order, event, tier = bundle["order"], bundle["event"], bundle["tier"]
    event.card_discounts = card_discounts
    dc = DiscountCode(
        event_id=event.id, code=code, discount_type=DiscountCodeType.PERCENTAGE, rate=10.0
    )
    db_session.add(dc)
    await db_session.flush()
    db_session.add(
        OrderItem(
            order_id=order.id, tier_id=tier.id, quantity=1,
            unit_price=Decimal("50000"), line_amount=Decimal("45000"),
            discount_code_id=dc.id,
        )
    )
    await db_session.flush()
    return bundle


@pytest.mark.asyncio
async def test_t14_resolves_card_discount_from_v2_ledger(db_session):
    """주문에 실제 적용된 할인코드로 카드사를 판정한다(클라 주장이 아니라 v2 원장)."""
    bundle = await _order_with_discount_code(
        db_session, code="BC-AUTO-XYZ",
        card_discounts={"BC": {"rate": 10, "discount_code": "BC-AUTO-XYZ", "card_code": "01"}},
    )
    svc = PaymentService(db_session)
    got = await svc._resolve_order_card_discount(bundle["order"])
    assert got == {"card": "BC", "card_code": "01", "discount_code": "BC-AUTO-XYZ"}


@pytest.mark.asyncio
async def test_t14_resolves_case_insensitively(db_session):
    """🔴 설정에 소문자를 써도 판정된다 — v2 는 코드를 **대문자로 저장**한다.

    정규화가 없으면 validate 는 통과하고(대문자 조회) 이 비교만 어긋나서
    card_discount 가 미기록되고 T15 가 조기 return 한다 = 설정 오타 하나로
    **검증 0의 10% 할인**. 조용한 fail-open 이라 테스트로 못 잡으면 영원히 모른다.
    """
    bundle = await _order_with_discount_code(
        db_session, code="BC-AUTO-XYZ",  # v2 저장값(대문자)
        card_discounts={"BC": {"rate": 10, "discount_code": "bc-auto-xyz", "card_code": "01"}},
    )
    svc = PaymentService(db_session)
    got = await svc._resolve_order_card_discount(bundle["order"])
    assert got is not None, "대소문자 차이로 검증이 통째로 꺼졌다(fail-open)"
    assert got["card"] == "BC"


@pytest.mark.asyncio
async def test_t14_ignores_unrelated_promo_code(db_session):
    """일반 프로모코드가 적용된 주문은 카드사 할인이 아니다(과잉적용 금지)."""
    bundle = await _order_with_discount_code(
        db_session, code="WELCOME10",
        card_discounts={"BC": {"rate": 10, "discount_code": "BC-AUTO-XYZ", "card_code": "01"}},
    )
    svc = PaymentService(db_session)
    assert await svc._resolve_order_card_discount(bundle["order"]) is None


@pytest.mark.asyncio
async def test_t14_returns_none_when_event_has_no_card_discounts(db_session):
    """card_discounts 미설정 이벤트는 현행 동작 불변 — 추가 부하도 이벤트 조회 1회로 끝난다."""
    bundle = await _order_with_discount_code(
        db_session, code="BC-AUTO-XYZ", card_discounts=None,
    )
    svc = PaymentService(db_session)
    assert await svc._resolve_order_card_discount(bundle["order"]) is None


# ── T15 — BC 계열 복수 카드사 (2026-08-02 대표 결정) ─────────────────────────
#
# 🔴 BC 계열은 하나가 아니다. [NICEPAY] 인증결제-2.1.3.pdf [표 11-1] p.28 원문:
#
#     비씨 01 · 우리 BC 15 · 우리 17
#
# `01` 만 인정하면 **우리BC 카드 손님이 T15 에서 승인취소**된다. 결제 완료 화면을 본 뒤
# 취소되는 모양이라 체감이 특히 나쁘고, BC카드가 타이틀 스폰서인 대회에서 스폰서 클레임이 된다.
#
# 대표 결정: **우리BC(15) 포함**. `우리(17)` 은 BC 제휴가 아니라 제외.
#
# `SelectCardCode` 는 콤마 나열을 받으므로(PDF §11-1: `SelectCardCode=02,04,07`)
# 설정 문자열 하나가 결제창 제한과 T15 검증 양쪽에 쓰인다 — 파싱은 `parse_card_codes` 한 곳.


@pytest.mark.asyncio
async def test_t15_accepts_woori_bc_when_family_configured(monkeypatch):
    """🔴 우리BC(15)로 승인돼도 통과한다 — 설정이 BC 계열이면."""
    voided: list = []
    svc = _svc_with_spy(monkeypatch, voided)
    order = _Order({"card_discount": {"card": "BC", "card_code": "01,15"}})

    await svc._enforce_card_discount_issuer(
        order, _Verified({"CardCode": "15", "CardName": "우리BC"})
    )

    assert voided == [], "우리BC 인데 승인이 취소됐다 — 손님이 결제 후 취소를 겪는다"
    assert order.payment_metadata["card_issuer"] == {"code": "15", "name": "우리BC"}


@pytest.mark.asyncio
async def test_t15_still_accepts_bc_when_family_configured(monkeypatch):
    """비씨(01)도 그대로 통과한다 — 확장이 기존 동작을 깨지 않는다."""
    voided: list = []
    svc = _svc_with_spy(monkeypatch, voided)
    order = _Order({"card_discount": {"card": "BC", "card_code": "01,15"}})

    await svc._enforce_card_discount_issuer(
        order, _Verified({"CardCode": "01", "CardName": "비씨"})
    )
    assert voided == []


@pytest.mark.asyncio
async def test_t15_rejects_woori_non_bc(monkeypatch):
    """🔴 우리(17)는 BC 제휴가 아니다 — 목록을 넓히면서 통째로 열어버리면 안 된다."""
    voided: list = []
    svc = _svc_with_spy(monkeypatch, voided)
    order = _Order({"card_discount": {"card": "BC", "card_code": "01,15"}})

    with pytest.raises(ValueError):
        await svc._enforce_card_discount_issuer(
            order, _Verified({"CardCode": "17", "CardName": "우리"})
        )
    assert len(voided) == 1


@pytest.mark.asyncio
async def test_t15_rejects_unrelated_card_with_family(monkeypatch):
    """목록 밖 카드(삼성 04)는 여전히 거절 — 확장이 검증을 무력화하지 않는다."""
    voided: list = []
    svc = _svc_with_spy(monkeypatch, voided)
    order = _Order({"card_discount": {"card": "BC", "card_code": "01,15"}})

    with pytest.raises(ValueError):
        await svc._enforce_card_discount_issuer(order, _Verified({"CardCode": "04"}))
    assert len(voided) == 1


@pytest.mark.asyncio
async def test_t15_stays_fail_closed_with_family(monkeypatch):
    """🔴 카드사 **확인불가**는 목록이 넓어져도 여전히 거절이다.

    `code in expected_set` 로 바꿀 때 `None in set` 이 False 라 우연히 막히는 게 아니라,
    `code and ...` 로 **명시적으로** 막는다. 빈 문자열이 목록에 섞여도 통과하면 안 된다.
    """
    voided: list = []
    svc = _svc_with_spy(monkeypatch, voided)
    order = _Order({"card_discount": {"card": "BC", "card_code": "01,15"}})

    with pytest.raises(ValueError):
        await svc._enforce_card_discount_issuer(order, _Verified({"TID": "x"}))
    assert len(voided) == 1


def test_parse_card_codes_handles_list_and_padding():
    """콤마 나열·공백·1자리 zero-pad 를 한 곳에서 처리한다."""
    from app.services.nicepay_gateway import parse_card_codes

    assert parse_card_codes("01,15") == {"01", "15"}
    assert parse_card_codes(" 01 , 15 ") == {"01", "15"}
    assert parse_card_codes("1,15") == {"01", "15"}, "1자리 코드가 zero-pad 되지 않았다"
    assert parse_card_codes("01") == {"01"}
    assert parse_card_codes("") == set()
    assert parse_card_codes(None) == set()
    assert parse_card_codes("01,,15") == {"01", "15"}, "빈 항목이 집합에 섞였다"
