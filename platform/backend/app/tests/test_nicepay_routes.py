"""NICEPAY 구형/정규 returnUrl·웹훅 라우트/서비스 테스트 (feat/nicepay-legacy).

게이트 커버리지:
  G1 returnUrl 4중검증(authResultCode+sig+orderId+금액) · 쿠키 의존 없음
  G2 서명 필수 · 변조/누락 거부(게이트웨이 compare_digest)
  G5 tid 멱등 · returnUrl↔웹훅 이중확정 방어
  G8 웹훅 OK · IP 화이트리스트 · 부분취소 명시분기
  G9 vbank ready→pending(확정 안 함) · 유실 fallback=웹훅 paid 확정

구형 배선(NICEPAY-LEGACY-VERIFIED-SPEC):
  - env = NICE_MID / NICE_MERCHANT_KEY (신형 clientKey/secretKey 폐기).
  - 인증응답 Signature = Hex(SHA256(AuthToken + MID + Amt + MerchantKey)).
  - 웹훅 Signature(잠정) = Hex(SHA256(TID + MID + Amt + MerchantKey)).
  - returnUrl·웹훅 모두 EUC-KR form POST(대문자 필드).

목킹: NicepayGateway.verify_payment 를 스텁해 실 HTTP/실키 없이 승인 흐름을 검증한다.
서명검증(verify_returnurl_signature/verify_webhook_signature)은 실 MerchantKey 로 실계산.
"""

import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.core.config import settings
from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus, OrderType
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.services.nicepay_gateway import NicepayGateway
from app.services.payment_gateway import PaymentVerificationResult
from app.services.payment_service import PaymentService, NiceReturnResult


# 구형: 상점 MID + 서버전용 MerchantKey (실키 아님, 테스트 상수).
_MID = "nicepay00m"
_MERCHANT_KEY = "433a8421be754b34989048cf148a5ffc"
# 나이스 인증응답 NextAppURL(승인 POST 대상) — 게이트웨이 SSRF 허용호스트.
_NEXT_APP_URL = "https://dc1-api.nicepay.co.kr/webapi/pay_process.jsp"


def _sha256_hex(value: str) -> str:
    # 게이트웨이는 소문자 hex 로 비교(_sha256_hex(...).lower()). hexdigest 는 이미 소문자.
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _returnurl_sig(auth_token: str, amount: str) -> str:
    """인증응답 Signature = Hex(SHA256(AuthToken + MID + Amt + MerchantKey))."""
    return _sha256_hex(f"{auth_token}{_MID}{amount}{_MERCHANT_KEY}")


def _webhook_sig(tid: str, amount) -> str:
    """웹훅 Signature(잠정) = Hex(SHA256(TID + MID + Amt + MerchantKey))."""
    return _sha256_hex(f"{tid}{_MID}{amount}{_MERCHANT_KEY}")


async def _create_order_bundle(
    db_session,
    *,
    order_status: OrderStatus = OrderStatus.PAYMENT_REQUIRED,
    payment_id: str | None = "ord_nice_test_a1",
    external_ref: str | None = None,
    total_amount: float = 1004.0,
    pg_provider: str = "nicepay",
    pg_transaction_id: str | None = None,
    payment_metadata: dict | None = None,
):
    now = datetime.now(timezone.utc)
    organizer = User(
        email=f"nice_org_{uuid.uuid4().hex[:8]}@test.com",
        hashed_password="x",
        name="Org",
        is_organizer=True,
    )
    buyer = User(
        email=f"nice_buyer_{uuid.uuid4().hex[:8]}@test.com",
        hashed_password="x",
        name="Buyer",
    )
    db_session.add_all([organizer, buyer])
    await db_session.flush()

    event = Event(
        organizer_id=organizer.id,
        title="Nice Test Event",
        slug=f"test-nice-{uuid.uuid4().hex[:8]}",
        venue="Arena",
        event_date=now + timedelta(days=30),
        bidding_opens_at=now - timedelta(days=1),
        bidding_closes_at=now + timedelta(days=1),
        total_seats=100,
        min_price=10.0,
        max_price=2000.0,
        status=EventStatus.BIDDING_OPEN,
    )
    db_session.add(event)
    await db_session.flush()

    tier = SeatTier(
        event_id=event.id,
        name="VIP",
        capacity=100,
        base_price=total_amount,
        face_price=total_amount,
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
        unit_price=total_amount,
        total_amount=total_amount,
        payment_id=payment_id,
        external_ref=external_ref,
        payment_deadline=now + timedelta(minutes=30),
        payment_currency="KRW",
        pg_provider=pg_provider,
        pg_transaction_id=pg_transaction_id,
        payment_metadata=payment_metadata,
    )
    db_session.add(order)
    await db_session.flush()

    ticket = Ticket(
        event_id=event.id,
        tier_id=tier.id,
        original_owner_id=buyer.id,
        current_owner_id=buyer.id,
        purchase_price=total_amount,
        sale_mode="fixed_fcfs",
        purchase_order_id=order.id,
        status=TicketStatus.PENDING,
    )
    db_session.add(ticket)
    await db_session.flush()

    return {"buyer": buyer, "order": order, "ticket": ticket, "tier": tier, "event": event}


def _live_nice_gateway(monkeypatch) -> NicepayGateway:
    """구형 env(NICE_MID/NICE_MERCHANT_KEY)로 실서명 계산 가능한 게이트웨이."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    gw = NicepayGateway()
    assert gw.mock_mode is False
    return gw


def _stub_approval(gw: NicepayGateway, monkeypatch, *, status: str = "paid", amount: float = 1004.0):
    """verify_payment(승인)를 스텁 — 실 HTTP 없이 paid/ready 반환.

    구형 배선: verify_payment 는 auth_token·next_app_url kwarg 를 받는다(기본 None).
    스텁이 이를 흡수해 라우트/서비스가 실제로 넘기는지(승인 경로)와 무관히 성공 반환.
    """

    async def fake_verify_payment(
        *, payment_id, transaction_id, expected_amount, currency,
        expected_statuses=None, auth_token=None, next_app_url=None,
    ):
        raw = {"ResultCode": "3001", "status": status, "Moid": payment_id, "TID": transaction_id}
        if status == "ready":
            raw = {**raw, "ResultCode": "4100", "_pending": True, "_normalized_status": "authorized"}
        return PaymentVerificationResult(
            provider="nicepay",
            payment_id=payment_id,
            transaction_id=transaction_id,
            amount=expected_amount,
            currency=currency,
            raw=raw,
        )

    monkeypatch.setattr(gw, "verify_payment", fake_verify_payment)


def _stub_inquiry(gw: NicepayGateway, monkeypatch, *, status: str = "paid", amount=1004, tid: str = "nictid_route"):
    """fetch_payment_by_order_id(거래조회)를 스텁 — A2 웹훅 재검증 근거.

    A2 이후 웹훅 확정의 1차 근거는 거래조회다. 실 HTTP 없이 원거래가 존재/정합함을
    반환한다(status='paid', 금액 일치). None 을 주면 '거래 미존재'로 처리되어
    fail-closed(비확정)를 검증할 수 있다.
    """

    async def fake_fetch(order_id, *, transaction_id=None):
        assert transaction_id == tid
        return {
            "TID": tid,
            "Moid": order_id,
            "Amt": str(amount),
            "Status": "0" if status == "paid" else "1",
            "ResultCode": "0000",
        }

    monkeypatch.setattr(gw, "fetch_payment_by_order_id", fake_fetch)


def _svc_with_nice(db_session, gw) -> PaymentService:
    svc = PaymentService(db_session)
    svc.gateway = gw  # _gateway_for(order) 가 pg_provider=nicepay 면 이걸 재사용
    return svc


# ═══════════════════════════════════════════════════════════════════════
# handle_nice_return — 구형 4중검증 + 승인 + 확정
# ═══════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_return_happy_path_confirms(db_session, monkeypatch):
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch, status="paid")
    bundle = await _create_order_bundle(db_session, payment_id="ord_ok_a1", total_amount=1004.0)
    svc = _svc_with_nice(db_session, gw)

    sig = _returnurl_sig("authtok", "1004")
    res = await svc.handle_nice_return(
        auth_result_code="0000", tid="nictid001", auth_token="authtok",
        order_id="ord_ok_a1", client_id=_MID, amount_raw="1004", signature=sig,
        next_app_url=_NEXT_APP_URL,
    )
    assert res.ok is True
    assert res.reason == "confirmed"
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED
    assert bundle["order"].pg_transaction_id == "nictid001"
    await db_session.refresh(bundle["ticket"])
    assert bundle["ticket"].status == TicketStatus.ACTIVE


@pytest.mark.asyncio
async def test_confirm_ignores_request_provider_and_keeps_order_provider(db_session, monkeypatch):
    """검증된 NICE 주문의 pg_provider는 요청 body 값으로 덮어쓸 수 없다."""
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch, status="paid")
    bundle = await _create_order_bundle(db_session, payment_id="ord_provider_ssot", total_amount=1004.0)
    svc = _svc_with_nice(db_session, gw)
    await svc.confirm_payment(
        bundle["order"].id,
        pg_provider="toss",
        pg_txn_id="nictid_provider_ssot",
        payment_id="ord_provider_ssot",
        amount=1004,
    )
    await db_session.refresh(bundle["order"])
    assert bundle["order"].pg_provider == "nicepay"


@pytest.mark.asyncio
async def test_return_signature_missing_rejected(db_session, monkeypatch):
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch)
    await _create_order_bundle(db_session, payment_id="ord_nosig_a1", total_amount=1004.0)
    svc = _svc_with_nice(db_session, gw)

    for bad in (None, "", "   "):
        res = await svc.handle_nice_return(
            auth_result_code="0000", tid="t", auth_token="authtok",
            order_id="ord_nosig_a1", client_id=_MID, amount_raw="1004", signature=bad,
            next_app_url=_NEXT_APP_URL,
        )
        assert res.ok is False and res.reason == "signature_invalid"


@pytest.mark.asyncio
async def test_return_signature_tampered_rejected(db_session, monkeypatch):
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch)
    await _create_order_bundle(db_session, payment_id="ord_badsig_a1", total_amount=1004.0)
    svc = _svc_with_nice(db_session, gw)

    good = _returnurl_sig("authtok", "1004")
    tampered = ("0" if good[0] != "0" else "1") + good[1:]
    res = await svc.handle_nice_return(
        auth_result_code="0000", tid="t", auth_token="authtok",
        order_id="ord_badsig_a1", client_id=_MID, amount_raw="1004", signature=tampered,
        next_app_url=_NEXT_APP_URL,
    )
    assert res.ok is False and res.reason == "signature_invalid"


@pytest.mark.asyncio
async def test_return_mid_mismatch_rejected(db_session, monkeypatch):
    """구형: 폼이 보낸 MID(client_id)가 config MID 와 다르면 서명검증 fail-closed."""
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch)
    await _create_order_bundle(db_session, payment_id="ord_midbad_a1", total_amount=1004.0)
    svc = _svc_with_nice(db_session, gw)

    # 서명은 진짜 MID 로 만들었지만 client_id 는 위조 MID → _verify_mid 불일치.
    sig = _returnurl_sig("authtok", "1004")
    res = await svc.handle_nice_return(
        auth_result_code="0000", tid="t", auth_token="authtok",
        order_id="ord_midbad_a1", client_id="evil_mid", amount_raw="1004", signature=sig,
        next_app_url=_NEXT_APP_URL,
    )
    assert res.ok is False and res.reason == "signature_invalid"


@pytest.mark.asyncio
async def test_return_amount_mismatch_rejected(db_session, monkeypatch):
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch)
    await _create_order_bundle(db_session, payment_id="ord_amt_a1", total_amount=1004.0)
    svc = _svc_with_nice(db_session, gw)

    # returnUrl Amt=2000 (DB=1004). 서명은 2000 으로 만들어 서명검증은 통과시키고
    # 금액검증에서만 걸리게 한다.
    sig = _returnurl_sig("authtok", "2000")
    res = await svc.handle_nice_return(
        auth_result_code="0000", tid="t", auth_token="authtok",
        order_id="ord_amt_a1", client_id=_MID, amount_raw="2000", signature=sig,
        next_app_url=_NEXT_APP_URL,
    )
    assert res.ok is False and res.reason == "amount_mismatch"


@pytest.mark.asyncio
async def test_return_auth_result_code_not_0000_rejected(db_session, monkeypatch):
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch)
    await _create_order_bundle(db_session, payment_id="ord_authfail_a1")
    svc = _svc_with_nice(db_session, gw)

    res = await svc.handle_nice_return(
        auth_result_code="9999", tid="t", auth_token="authtok",
        order_id="ord_authfail_a1", client_id=_MID, amount_raw="1004",
        signature=_returnurl_sig("authtok", "1004"), next_app_url=_NEXT_APP_URL,
    )
    assert res.ok is False and res.reason == "auth_failed"


@pytest.mark.asyncio
async def test_return_unknown_order_rejected(db_session, monkeypatch):
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch)
    svc = _svc_with_nice(db_session, gw)

    res = await svc.handle_nice_return(
        auth_result_code="0000", tid="t", auth_token="authtok",
        order_id="ord_ghost", client_id=_MID, amount_raw="1004",
        signature=_returnurl_sig("authtok", "1004"), next_app_url=_NEXT_APP_URL,
    )
    assert res.ok is False and res.reason == "order_not_found"


@pytest.mark.asyncio
async def test_return_already_confirmed_same_tid_idempotent(db_session, monkeypatch):
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch)
    await _create_order_bundle(
        db_session, payment_id="ord_dup_a1",
        order_status=OrderStatus.CONFIRMED, pg_transaction_id="nictid_dup",
    )
    svc = _svc_with_nice(db_session, gw)

    # 같은 tid 재진입 → 멱등 성공(재확정 안 함).
    res = await svc.handle_nice_return(
        auth_result_code="0000", tid="nictid_dup", auth_token="authtok",
        order_id="ord_dup_a1", client_id=_MID, amount_raw="1004",
        signature=_returnurl_sig("authtok", "1004"), next_app_url=_NEXT_APP_URL,
    )
    assert res.ok is True and res.reason == "already_confirmed"


@pytest.mark.asyncio
async def test_return_already_confirmed_different_tid_rejected(db_session, monkeypatch):
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch)
    await _create_order_bundle(
        db_session, payment_id="ord_dup2_a1",
        order_status=OrderStatus.CONFIRMED, pg_transaction_id="nictid_orig",
    )
    svc = _svc_with_nice(db_session, gw)

    res = await svc.handle_nice_return(
        auth_result_code="0000", tid="nictid_OTHER", auth_token="authtok",
        order_id="ord_dup2_a1", client_id=_MID, amount_raw="1004",
        signature=_returnurl_sig("authtok", "1004"), next_app_url=_NEXT_APP_URL,
    )
    assert res.ok is False and res.reason == "already_finalized"


@pytest.mark.asyncio
async def test_return_vbank_ready_stays_pending(db_session, monkeypatch):
    """G9: vbank 채번(ready) → 확정 안 하고 pending 유지."""
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch, status="ready")
    bundle = await _create_order_bundle(db_session, payment_id="ord_vbank_a1", total_amount=1004.0)
    svc = _svc_with_nice(db_session, gw)

    res = await svc.handle_nice_return(
        auth_result_code="0000", tid="nictid_vb", auth_token="authtok",
        order_id="ord_vbank_a1", client_id=_MID, amount_raw="1004",
        signature=_returnurl_sig("authtok", "1004"), next_app_url=_NEXT_APP_URL,
    )
    assert res.ok is True and res.reason == "vbank_pending"
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.PAYMENT_REQUIRED
    # tid 는 미리 저장돼 이후 웹훅 paid 가 찾을 수 있어야 한다.
    assert bundle["order"].pg_transaction_id == "nictid_vb"
    assert "vbank_pending" in (bundle["order"].payment_metadata or {})


@pytest.mark.asyncio
async def test_return_double_confirm_idempotent(db_session, monkeypatch):
    """returnUrl 두 번 호출 → 두 번째는 멱등(재확정·이중전파 없음)."""
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch, status="paid")
    bundle = await _create_order_bundle(db_session, payment_id="ord_twice_a1", total_amount=1004.0)
    svc = _svc_with_nice(db_session, gw)

    args = dict(
        auth_result_code="0000", tid="nictid_twice", auth_token="authtok",
        order_id="ord_twice_a1", client_id=_MID, amount_raw="1004",
        signature=_returnurl_sig("authtok", "1004"), next_app_url=_NEXT_APP_URL,
    )
    res1 = await svc.handle_nice_return(**args)
    assert res1.ok is True and res1.reason == "confirmed"
    res2 = await svc.handle_nice_return(**args)
    assert res2.ok is True and res2.reason == "already_confirmed"
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED
    assert bundle["order"].pg_transaction_id == "nictid_twice"


# ═══════════════════════════════════════════════════════════════════════
# handle_nice_webhook — vbank paid / 부분취소 / 만료
# ═══════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_webhook_vbank_paid_confirms_pending_order(db_session, monkeypatch):
    """G9 fallback: pending vbank 주문에 paid 웹훅 → 확정."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    bundle = await _create_order_bundle(db_session, payment_id="ord_wpaid_a1", total_amount=1004.0)

    svc = PaymentService(db_session)
    # 웹훅 경로 confirm 은 _gateway_for(order=nicepay)를 쓴다 → 기본 게이트웨이 교체.
    from app.services import payment_gateway as pgmod
    nice = pgmod.get_payment_gateway("nicepay")
    _stub_approval(nice, monkeypatch, status="paid")
    _stub_inquiry(nice, monkeypatch, status="paid", amount=1004, tid="nictid_wp")
    monkeypatch.setattr(pgmod, "get_payment_gateway", lambda provider=None: nice)
    svc.gateway = nice

    # 구형 통보(대문자 필드).
    payload = {
        "ResultCode": "4110", "status": "paid", "TID": "nictid_wp",
        "Moid": "ord_wpaid_a1", "Amt": "1004", "EdiDate": "20210727200708",
    }
    props = await svc.handle_nice_webhook(payload=payload)
    assert props and props[0]["event"] == "order.payment.confirmed"
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED


@pytest.mark.asyncio
async def test_webhook_vbank_4110_does_not_call_approval(db_session, monkeypatch):
    """4110 입금통보는 pay_process 승인 호출 없이 거래조회로 확정한다."""
    _live_nice_gateway(monkeypatch)
    bundle = await _create_order_bundle(
        db_session, payment_id="ord_wpaid_no_approval", total_amount=1004.0
    )
    from app.services import payment_gateway as pgmod

    nice = pgmod.get_payment_gateway("nicepay")
    _stub_inquiry(nice, monkeypatch, status="paid", amount=1004, tid="nictid_no_approval")

    async def fail_approval(**_kwargs):
        raise AssertionError("vbank deposit must not call approval")

    monkeypatch.setattr(nice, "verify_payment", fail_approval)
    monkeypatch.setattr(pgmod, "get_payment_gateway", lambda provider=None: nice)
    svc = PaymentService(db_session)
    svc.gateway = nice
    await svc.handle_nice_webhook(
        payload={
            "ResultCode": "4110",
            "status": "paid",
            "TID": "nictid_no_approval",
            "Moid": "ord_wpaid_no_approval",
            "Amt": "1004",
        }
    )
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED


@pytest.mark.asyncio
async def test_webhook_dedup_second_event_ignored(db_session, monkeypatch):
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    bundle = await _create_order_bundle(
        db_session, payment_id="ord_dedup_a1",
        order_status=OrderStatus.CONFIRMED, pg_transaction_id="nictid_ded",
    )
    # 이미 이 이벤트를 처리했다고 표시.
    order = bundle["order"]
    # parse_webhook_event 의 event_id = f"{tid}:{status}:{edi}"
    order.payment_webhook_event_id = "nictid_ded:cancelled:20210727200708"
    await db_session.flush()

    svc = PaymentService(db_session)
    from app.services import payment_gateway as pgmod
    nice = pgmod.get_payment_gateway("nicepay")
    monkeypatch.setattr(pgmod, "get_payment_gateway", lambda provider=None: nice)

    payload = {
        "ResultCode": "2001", "status": "cancelled", "TID": "nictid_ded",
        "Moid": "ord_dedup_a1", "Amt": "1004", "EdiDate": "20210727200708",
    }
    props = await svc.handle_nice_webhook(payload=payload)
    assert props is None  # 중복 → 무시


@pytest.mark.asyncio
async def test_webhook_partial_cancel_applies_refund(db_session, monkeypatch):
    """G8: partialCancelled 웹훅 → total_refunded 반영, 주문은 취소 안 됨(부분)."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    bundle = await _create_order_bundle(
        db_session, payment_id="ord_partial_a1",
        order_status=OrderStatus.CONFIRMED, total_amount=1004.0,
        pg_transaction_id="nictid_p",
    )
    svc = PaymentService(db_session)
    from app.services import payment_gateway as pgmod
    nice = pgmod.get_payment_gateway("nicepay")
    monkeypatch.setattr(pgmod, "get_payment_gateway", lambda provider=None: nice)

    payload = {
        "ResultCode": "2211", "status": "partialCancelled", "TID": "nictid_p",
        "cancelledTid": "nictid_pCANCEL", "Moid": "ord_partial_a1",
        "Amt": 1004, "balanceAmt": 504, "EdiDate": "20210727200708",
        "cancels": [{"amount": 500, "reason": "부분환불"}],
    }
    await svc.handle_nice_webhook(payload=payload)
    await db_session.refresh(bundle["order"])
    assert float(bundle["order"].total_refunded) == 500.0
    # 부분취소는 주문을 REFUNDED/CANCELLED 로 바꾸지 않는다.
    assert bundle["order"].status == OrderStatus.CONFIRMED
    assert "nice_cancel_webhook" in (bundle["order"].payment_metadata or {})


@pytest.mark.asyncio
async def test_webhook_full_cancel_refunds_order(db_session, monkeypatch):
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    bundle = await _create_order_bundle(
        db_session, payment_id="ord_fullcancel_a1",
        order_status=OrderStatus.CONFIRMED, total_amount=1004.0,
        pg_transaction_id="nictid_fc",
    )
    svc = PaymentService(db_session)
    from app.services import payment_gateway as pgmod
    nice = pgmod.get_payment_gateway("nicepay")
    monkeypatch.setattr(pgmod, "get_payment_gateway", lambda provider=None: nice)

    payload = {
        "ResultCode": "2001", "status": "cancelled", "TID": "nictid_fc",
        "Moid": "ord_fullcancel_a1", "Amt": 1004, "balanceAmt": 0,
        "EdiDate": "20210727200708",
    }
    props = await svc.handle_nice_webhook(payload=payload)
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.REFUNDED
    assert float(bundle["order"].total_refunded) == 1004.0
    assert props and props[0]["event"] == "order.cancelled"


# ═══════════════════════════════════════════════════════════════════════
# HTTP 라우트 (returnUrl 302 · 웹훅 IP/서명/OK) — EUC-KR form POST
# ═══════════════════════════════════════════════════════════════════════


def _patch_route_db(monkeypatch):
    """라우트가 여는 async_session() 을 테스트 SQLite(TestSession)로 바꾼다."""
    import app.api.v1.payment_webhook as pw
    from app.tests.conftest import TestSession

    monkeypatch.setattr(pw, "async_session", TestSession, raising=False)


def _euckr_post_kwargs(fields: dict) -> dict:
    """EUC-KR form-urlencoded 본문을 만들어 httpx content= 로 넘길 kwargs 반환.

    구형 나이스는 EUC-KR form POST 로 통보한다. 라우트 _parse_nice_euckr_form 이
    raw body 를 EUC-KR 로 디코드하는 경로를 실검증한다.
    """
    from urllib.parse import urlencode

    body = urlencode({k: ("" if v is None else str(v)) for k, v in fields.items()}, encoding="euc-kr")
    return {
        "content": body.encode("euc-kr", errors="replace"),
        "headers": {"content-type": "application/x-www-form-urlencoded; charset=euc-kr"},
    }


@pytest.mark.asyncio
async def test_webhook_route_signature_valid_returns_ok(client, db_session, monkeypatch):
    """서명 통과 웹훅(EUC-KR form) → 200 · body 'OK' · 확정."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    monkeypatch.setattr(settings, "ENVIRONMENT", "test", raising=False)
    _patch_route_db(monkeypatch)

    # pending vbank 주문 시드 → paid 웹훅으로 확정.
    from app.services import payment_gateway as pgmod
    nice = pgmod.get_payment_gateway("nicepay")
    _stub_approval(nice, monkeypatch, status="paid")
    # A2: 웹훅 확정의 1차 근거 = 거래조회. 원거래 정합(paid·금액일치)을 스텁.
    _stub_inquiry(nice, monkeypatch, status="paid", amount=1004, tid="nictid_route")
    monkeypatch.setattr(pgmod, "get_payment_gateway", lambda provider=None: nice)
    monkeypatch.setattr("app.services.payment_service.get_payment_gateway", lambda provider=None: nice)
    # A2: 라우트 재검증도 스텁 게이트웨이(fetch_payment_by_order_id)를 쓰게 한다.
    monkeypatch.setattr("app.api.v1.payment_webhook.get_payment_gateway", lambda provider=None: nice)

    bundle = await _create_order_bundle(db_session, payment_id="ord_route_ok_a1", total_amount=1004.0)
    await db_session.commit()

    tid = "nictid_route"
    sig = _webhook_sig(tid, 1004)
    resp = await client.post(
        "/api/v1/webhooks/nice",
        **_euckr_post_kwargs({
            "ResultCode": "4110", "status": "paid", "TID": tid,
            "Moid": "ord_route_ok_a1", "Amt": 1004,
            "EdiDate": "20210727200708", "Signature": sig,
        }),
    )
    assert resp.status_code == 200
    assert resp.text == "OK"
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED


@pytest.mark.asyncio
async def test_webhook_route_bad_signature_200_not_confirmed(client, db_session, monkeypatch):
    """서명 실패 + 거래조회 미존재 → 200(재전송 억제) · body 'OK' · 확정 없음(A2 fail-closed)."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    monkeypatch.setattr(settings, "ENVIRONMENT", "test", raising=False)
    _patch_route_db(monkeypatch)

    # A2: 거래조회 미존재(None) → 거래조회로도 확정 불가. 서명도 실패 → 비확정.
    from app.services import payment_gateway as pgmod
    nice = pgmod.get_payment_gateway("nicepay")

    async def _fetch_none(order_id, *, transaction_id=None):
        return None

    monkeypatch.setattr(nice, "fetch_payment_by_order_id", _fetch_none)
    monkeypatch.setattr(pgmod, "get_payment_gateway", lambda provider=None: nice)

    bundle = await _create_order_bundle(db_session, payment_id="ord_route_bad_a1", total_amount=1004.0)
    await db_session.commit()

    resp = await client.post(
        "/api/v1/webhooks/nice",
        **_euckr_post_kwargs({
            "ResultCode": "4110", "status": "paid", "TID": "nictid_bad",
            "Moid": "ord_route_bad_a1", "Amt": 1004,
            "EdiDate": "20210727200708", "Signature": "deadbeefbad",
        }),
    )
    assert resp.status_code == 200
    assert resp.text == "OK"
    # 확정 안 됨 — 서명 실패 + 거래조회 미존재는 비확정.
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.PAYMENT_REQUIRED


@pytest.mark.asyncio
async def test_webhook_route_no_signature_confirms_via_inquiry(client, db_session, monkeypatch):
    """A2: 서명 없음(누락)이어도 거래조회 정합이면 확정 — vbank 4110 유실 방지."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    monkeypatch.setattr(settings, "ENVIRONMENT", "test", raising=False)
    _patch_route_db(monkeypatch)

    from app.services import payment_gateway as pgmod
    nice = pgmod.get_payment_gateway("nicepay")
    _stub_approval(nice, monkeypatch, status="paid")
    # 거래조회로 원거래 정합 확인(paid·금액일치) — 서명 필드는 아예 안 보낸다.
    _stub_inquiry(nice, monkeypatch, status="paid", amount=1004, tid="nictid_nosig")
    monkeypatch.setattr(pgmod, "get_payment_gateway", lambda provider=None: nice)
    monkeypatch.setattr("app.services.payment_service.get_payment_gateway", lambda provider=None: nice)
    monkeypatch.setattr("app.api.v1.payment_webhook.get_payment_gateway", lambda provider=None: nice)

    bundle = await _create_order_bundle(db_session, payment_id="ord_route_nosig_a1", total_amount=1004.0)
    await db_session.commit()

    resp = await client.post(
        "/api/v1/webhooks/nice",
        **_euckr_post_kwargs({
            # Signature 필드 자체를 생략 — 서명 단독 신뢰 금지 검증.
            "ResultCode": "4110", "status": "paid", "TID": "nictid_nosig",
            "Moid": "ord_route_nosig_a1", "Amt": 1004, "EdiDate": "20210727200708",
        }),
    )
    assert resp.status_code == 200
    assert resp.text == "OK"
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED


@pytest.mark.asyncio
async def test_webhook_route_inquiry_amount_mismatch_fail_closed(client, db_session, monkeypatch):
    """A2: 유효 서명이어도 거래조회 금액이 다르면 fail-closed(비확정) — 위변조 방어."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    monkeypatch.setattr(settings, "ENVIRONMENT", "test", raising=False)
    _patch_route_db(monkeypatch)

    from app.services import payment_gateway as pgmod
    nice = pgmod.get_payment_gateway("nicepay")
    _stub_approval(nice, monkeypatch, status="paid")
    # 거래조회 정본 금액=9999(웹훅 주장 1004 와 불일치) → mismatch fail-closed.
    _stub_inquiry(nice, monkeypatch, status="paid", amount=9999, tid="nictid_mm")
    monkeypatch.setattr(pgmod, "get_payment_gateway", lambda provider=None: nice)
    monkeypatch.setattr("app.services.payment_service.get_payment_gateway", lambda provider=None: nice)
    monkeypatch.setattr("app.api.v1.payment_webhook.get_payment_gateway", lambda provider=None: nice)

    bundle = await _create_order_bundle(db_session, payment_id="ord_route_mm_a1", total_amount=1004.0)
    await db_session.commit()

    tid = "nictid_mm"
    sig = _webhook_sig(tid, 1004)  # 웹훅 서명은 유효(주장 금액 1004 기준)
    resp = await client.post(
        "/api/v1/webhooks/nice",
        **_euckr_post_kwargs({
            "ResultCode": "4110", "status": "paid", "TID": tid,
            "Moid": "ord_route_mm_a1", "Amt": 1004,
            "EdiDate": "20210727200708", "Signature": sig,
        }),
    )
    assert resp.status_code == 200
    assert resp.text == "OK"
    # 서명은 통과했어도 거래조회 금액 불일치 → 확정 거부.
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.PAYMENT_REQUIRED


@pytest.mark.asyncio
async def test_webhook_route_ip_rejected_in_production(client, monkeypatch):
    """production + 비허용 IP → 403."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "ENVIRONMENT", "production", raising=False)
    monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "nicepay", raising=False)
    # 테스트 클라이언트의 client.host 는 허용목록에 없다 → 403.
    resp = await client.post(
        "/api/v1/webhooks/nice",
        **_euckr_post_kwargs({"status": "paid", "TID": "x", "Moid": "y", "Amt": 1}),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_return_route_redirects_302_on_bad_signature(client, db_session, monkeypatch):
    """returnUrl 라우트(EUC-KR form): 서명 실패 → fail 페이지로 302 redirect."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    monkeypatch.setattr(settings, "PAYMENT_FAIL_URL", "http://localhost:3000/payment/fail", raising=False)
    _patch_route_db(monkeypatch)

    await _create_order_bundle(db_session, payment_id="ord_route_ret_a1", total_amount=1004.0)
    await db_session.commit()

    resp = await client.post(
        "/api/v1/payments/nice/return",
        **_euckr_post_kwargs({
            "AuthResultCode": "0000", "TxTid": "t", "AuthToken": "authtok",
            "Moid": "ord_route_ret_a1", "MID": _MID,
            "Amt": "1004", "Signature": "deadbeef", "NextAppURL": _NEXT_APP_URL,
        }),
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert "/payment/fail" in resp.headers["location"]
    assert "reason=signature_invalid" in resp.headers["location"]


@pytest.mark.asyncio
async def test_return_route_redirects_302_on_success(client, db_session, monkeypatch):
    """returnUrl 라우트(EUC-KR form): 4검증 통과 → 승인·확정 → success 페이지로 302."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    monkeypatch.setattr(settings, "PAYMENT_SUCCESS_URL", "http://localhost:3000/payment/success", raising=False)
    _patch_route_db(monkeypatch)

    from app.services import payment_gateway as pgmod
    nice = pgmod.get_payment_gateway("nicepay")
    _stub_approval(nice, monkeypatch, status="paid")
    monkeypatch.setattr(pgmod, "get_payment_gateway", lambda provider=None: nice)
    monkeypatch.setattr("app.services.payment_service.get_payment_gateway", lambda provider=None: nice)

    bundle = await _create_order_bundle(db_session, payment_id="ord_route_succ_a1", total_amount=1004.0)
    await db_session.commit()

    sig = _returnurl_sig("authtok", "1004")
    resp = await client.post(
        "/api/v1/payments/nice/return",
        **_euckr_post_kwargs({
            "AuthResultCode": "0000", "TxTid": "nictid_succ", "AuthToken": "authtok",
            "Moid": "ord_route_succ_a1", "MID": _MID,
            "Amt": "1004", "Signature": sig, "NextAppURL": _NEXT_APP_URL,
        }),
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert "/payment/success" in resp.headers["location"]
    assert "reason=confirmed" in resp.headers["location"]
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED


# ═══════════════════════════════════════════════════════════════════════
# Phase 2b — go-checkout(external_ref) orderId 조회 확장 + 리다이렉트 화이트리스트
# ═══════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_return_go_order_by_external_ref_confirms(db_session, monkeypatch):
    """go-checkout 주문: orderId=go order id(external_ref), payment_id=NULL 로도 조회·확정."""
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch, status="paid")
    go_order_id = str(uuid.uuid4())
    bundle = await _create_order_bundle(
        db_session, payment_id=None, external_ref=go_order_id, total_amount=1004.0
    )
    svc = _svc_with_nice(db_session, gw)

    sig = _returnurl_sig("authtok", "1004")
    res = await svc.handle_nice_return(
        auth_result_code="0000", tid="nictid_go", auth_token="authtok",
        order_id=go_order_id, client_id=_MID, amount_raw="1004", signature=sig,
        next_app_url=_NEXT_APP_URL,
    )
    assert res.ok is True and res.reason == "confirmed"
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED
    assert bundle["order"].pg_transaction_id == "nictid_go"


@pytest.mark.asyncio
async def test_return_consumer_by_payment_id_still_works(db_session, monkeypatch):
    """consumer 주문(payment_id 매칭) 회귀: 확장 후에도 payment_id 경로 정상."""
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch, status="paid")
    bundle = await _create_order_bundle(
        db_session, payment_id="ord_consumer_a1", external_ref=None, total_amount=1004.0
    )
    svc = _svc_with_nice(db_session, gw)

    sig = _returnurl_sig("authtok", "1004")
    res = await svc.handle_nice_return(
        auth_result_code="0000", tid="nictid_c", auth_token="authtok",
        order_id="ord_consumer_a1", client_id=_MID, amount_raw="1004", signature=sig,
        next_app_url=_NEXT_APP_URL,
    )
    assert res.ok is True and res.reason == "confirmed"
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED


@pytest.mark.asyncio
async def test_return_cross_order_not_matched(db_session, monkeypatch):
    """교차주문 거부: 다른 주문의 external_ref 로 조회 시 매칭 안 됨(IDOR 차단)."""
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch, status="paid")
    victim_ref = str(uuid.uuid4())
    await _create_order_bundle(
        db_session, payment_id=None, external_ref=victim_ref, total_amount=1004.0
    )
    # 존재하지 않는(다른) go order id 로 조회 → order_not_found.
    other_ref = str(uuid.uuid4())
    svc = _svc_with_nice(db_session, gw)
    res = await svc.handle_nice_return(
        auth_result_code="0000", tid="t", auth_token="authtok",
        order_id=other_ref, client_id=_MID, amount_raw="1004",
        signature=_returnurl_sig("authtok", "1004"), next_app_url=_NEXT_APP_URL,
    )
    assert res.ok is False and res.reason == "order_not_found"


@pytest.mark.asyncio
async def test_find_nice_order_payment_id_priority(db_session, monkeypatch):
    """_find_nice_order: payment_id 매칭 우선(정확 등호). external_ref-only 주문은 external_ref 로."""
    _live_nice_gateway(monkeypatch)
    consumer = await _create_order_bundle(
        db_session, payment_id="ord_prio_a1", external_ref=None, total_amount=1004.0
    )
    go_ref = str(uuid.uuid4())
    go = await _create_order_bundle(
        db_session, payment_id=None, external_ref=go_ref, total_amount=1004.0
    )
    svc = PaymentService(db_session)

    found_c = await svc._find_nice_order("ord_prio_a1")
    assert found_c is not None and found_c.id == consumer["order"].id
    found_g = await svc._find_nice_order(go_ref)
    assert found_g is not None and found_g.id == go["order"].id
    assert await svc._find_nice_order("does-not-exist") is None
    assert await svc._find_nice_order("") is None


@pytest.mark.asyncio
async def test_return_go_double_confirm_idempotent(db_session, monkeypatch):
    """go 주문 이중확정(return 2회) 멱등 — 같은 tid 재진입 시 already_confirmed."""
    gw = _live_nice_gateway(monkeypatch)
    _stub_approval(gw, monkeypatch, status="paid")
    go_ref = str(uuid.uuid4())
    bundle = await _create_order_bundle(
        db_session, payment_id=None, external_ref=go_ref, total_amount=1004.0
    )
    svc = _svc_with_nice(db_session, gw)
    args = dict(
        auth_result_code="0000", tid="nictid_dup_go", auth_token="authtok",
        order_id=go_ref, client_id=_MID, amount_raw="1004",
        signature=_returnurl_sig("authtok", "1004"), next_app_url=_NEXT_APP_URL,
    )
    res1 = await svc.handle_nice_return(**args)
    await db_session.refresh(bundle["order"])
    res2 = await svc.handle_nice_return(**args)
    assert res1.ok is True and res1.reason == "confirmed"
    assert res2.ok is True and res2.reason == "already_confirmed"


@pytest.mark.asyncio
async def test_webhook_go_order_by_external_ref(db_session, monkeypatch):
    """웹훅도 go 주문(external_ref)을 orderId(Moid)로 조회해 확정(paid)."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    from app.services import payment_gateway as pgmod
    nice = pgmod.get_payment_gateway("nicepay")
    _stub_approval(nice, monkeypatch, status="paid")
    _stub_inquiry(nice, monkeypatch, status="paid", amount=1004, tid="wh_go_tid")
    monkeypatch.setattr(pgmod, "get_payment_gateway", lambda provider=None: nice)
    monkeypatch.setattr("app.services.payment_service.get_payment_gateway", lambda provider=None: nice)

    go_ref = str(uuid.uuid4())
    bundle = await _create_order_bundle(
        db_session, payment_id=None, external_ref=go_ref, total_amount=1004.0
    )
    svc = PaymentService(db_session)
    props = await svc.handle_nice_webhook(payload={
        "ResultCode": "4110", "status": "paid", "TID": "wh_go_tid",
        "Moid": go_ref, "Amt": 1004, "EdiDate": "20210727200708",
        "Signature": _webhook_sig("wh_go_tid", 1004),
    })
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.CONFIRMED
    assert props and props[0]["event"] == "order.payment.confirmed"


# ── 리다이렉트 화이트리스트(mallReserved origin → config URL) ──────────────


def test_nice_redirect_targets_go_maps_to_go_urls(monkeypatch):
    from app.api.v1.payment_webhook import _nice_origin_of, _nice_redirect_targets
    monkeypatch.setattr(settings, "NICEPAY_GO_SUCCESS_URL", "https://go.example/checkout/nice/success", raising=False)
    # 질의 #11: consumer 폴백 제거로 두 URL 이 **쌍으로** 필요하다.
    # (이 테스트들이 FAIL_URL 을 빠뜨리고 있었고 새 가드가 그것을 잡았다.)
    monkeypatch.setattr(settings, "NICEPAY_GO_FAIL_URL", "https://go.example/checkout/nice/fail", raising=False)
    monkeypatch.setattr(settings, "NICEPAY_GO_FAIL_URL", "https://go.example/checkout/nice/fail", raising=False)
    s, f = _nice_redirect_targets(_nice_origin_of("go"))
    assert s == "https://go.example/checkout/nice/success"
    assert f == "https://go.example/checkout/nice/fail"


def test_nice_redirect_targets_consumer_maps_to_payment_urls(monkeypatch):
    from app.api.v1.payment_webhook import _nice_origin_of, _nice_redirect_targets
    monkeypatch.setattr(settings, "PAYMENT_SUCCESS_URL", "https://consumer.example/payment/success", raising=False)
    monkeypatch.setattr(settings, "PAYMENT_FAIL_URL", "https://consumer.example/payment/fail", raising=False)
    s, f = _nice_redirect_targets(_nice_origin_of("consumer"))
    assert s == "https://consumer.example/payment/success"
    assert f == "https://consumer.example/payment/fail"


def test_nice_redirect_targets_unknown_maps_to_consumer(monkeypatch):
    """미지 origin(임의 문자열·빈값): consumer 기본으로 라우팅(하위호환). URL 은 config 값만."""
    from app.api.v1.payment_webhook import _nice_origin_of, _nice_redirect_targets
    monkeypatch.setattr(settings, "PAYMENT_SUCCESS_URL", "https://consumer.example/payment/success", raising=False)
    monkeypatch.setattr(settings, "PAYMENT_FAIL_URL", "https://consumer.example/payment/fail", raising=False)
    for raw in ("https://evil.example/steal", "", None, "unknown-origin"):
        origin = _nice_origin_of(raw)
        assert origin == "consumer"
        s, f = _nice_redirect_targets(origin)
        assert s == "https://consumer.example/payment/success"
        assert f == "https://consumer.example/payment/fail"
    # "GO " 는 strip+lower 로 go 정규화(허용).
    assert _nice_origin_of("GO ") == "go"


def test_nice_origin_never_returns_user_url(monkeypatch):
    """open-redirect 차단: mallReserved 에 URL 을 넣어도 목적지는 config URL(사용자 URL 미반영)."""
    from app.api.v1.payment_webhook import _nice_origin_of, _nice_redirect_targets
    monkeypatch.setattr(settings, "PAYMENT_SUCCESS_URL", "https://safe.example/success", raising=False)
    monkeypatch.setattr(settings, "PAYMENT_FAIL_URL", "https://safe.example/fail", raising=False)
    origin = _nice_origin_of("https://attacker.example/phish")
    # 임의 URL 은 consumer(기본)로 접히고, 목적지는 config URL 만.
    s, f = _nice_redirect_targets(origin)
    assert "attacker" not in s and "attacker" not in f
    assert s == "https://safe.example/success" and f == "https://safe.example/fail"


@pytest.mark.asyncio
async def test_return_route_go_origin_redirects_to_go_url(client, db_session, monkeypatch):
    """returnUrl 라우트: MallReserved='go' → go success URL 로 302(consumer URL 아님)."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    monkeypatch.setattr(settings, "PAYMENT_SUCCESS_URL", "https://consumer.example/payment/success", raising=False)
    monkeypatch.setattr(settings, "NICEPAY_GO_SUCCESS_URL", "https://go.example/checkout/nice/success", raising=False)
    # 질의 #11: consumer 폴백 제거로 두 URL 이 **쌍으로** 필요하다.
    # (이 테스트들이 FAIL_URL 을 빠뜨리고 있었고 새 가드가 그것을 잡았다.)
    monkeypatch.setattr(settings, "NICEPAY_GO_FAIL_URL", "https://go.example/checkout/nice/fail", raising=False)
    _patch_route_db(monkeypatch)

    from app.services import payment_gateway as pgmod
    nice = pgmod.get_payment_gateway("nicepay")
    _stub_approval(nice, monkeypatch, status="paid")
    monkeypatch.setattr(pgmod, "get_payment_gateway", lambda provider=None: nice)
    monkeypatch.setattr("app.services.payment_service.get_payment_gateway", lambda provider=None: nice)

    go_ref = str(uuid.uuid4())
    await _create_order_bundle(db_session, payment_id=None, external_ref=go_ref, total_amount=1004.0)
    await db_session.commit()

    sig = _returnurl_sig("authtok", "1004")
    resp = await client.post(
        "/api/v1/payments/nice/return",
        **_euckr_post_kwargs({
            "AuthResultCode": "0000", "TxTid": "nictid_go_route", "AuthToken": "authtok",
            "Moid": go_ref, "MID": _MID,
            "Amt": "1004", "Signature": sig, "MallReserved": "go", "NextAppURL": _NEXT_APP_URL,
        }),
        follow_redirects=False,
    )
    assert resp.status_code == 302
    loc = resp.headers["location"]
    assert loc.startswith("https://go.example/checkout/nice/success")
    assert "consumer.example" not in loc
    assert "reason=confirmed" in loc and f"orderId={go_ref}" in loc


@pytest.mark.asyncio
async def test_return_route_consumer_origin_redirects_to_consumer_url(client, db_session, monkeypatch):
    """returnUrl 라우트: MallReserved 미지정/consumer → consumer URL(go URL 아님)."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    monkeypatch.setattr(settings, "PAYMENT_FAIL_URL", "https://consumer.example/payment/fail", raising=False)
    monkeypatch.setattr(settings, "NICEPAY_GO_FAIL_URL", "https://go.example/checkout/nice/fail", raising=False)
    _patch_route_db(monkeypatch)

    await _create_order_bundle(db_session, payment_id="ord_consumer_route_a1", total_amount=1004.0)
    await db_session.commit()

    # 서명 실패로 fail redirect 유도(consumer origin=미지정 → consumer fail).
    resp = await client.post(
        "/api/v1/payments/nice/return",
        **_euckr_post_kwargs({
            "AuthResultCode": "0000", "TxTid": "t", "AuthToken": "authtok",
            "Moid": "ord_consumer_route_a1", "MID": _MID,
            "Amt": "1004", "Signature": "deadbeef", "MallReserved": "consumer",
            "NextAppURL": _NEXT_APP_URL,
        }),
        follow_redirects=False,
    )
    assert resp.status_code == 302
    loc = resp.headers["location"]
    assert loc.startswith("https://consumer.example/payment/fail")
    assert "go.example" not in loc
    assert "reason=signature_invalid" in loc


# ─────────────────────────────────────────────────────────────────────────────
# 🔴 착지 origin 을 **원장**으로 판정 (2026-07-31)
#
# 위 두 테스트(`..._go_origin_...` / `..._consumer_origin_...`)는 form 에 `MallReserved`
# 를 **넣어 주고** 통과하고 있었다. 그런데 나이스는 인증 응답에 그 필드를 보내지 않는다
# (구형 스펙 §5.3). 즉 테스트가 실전에 없는 입력을 만들어 준 **거짓 그린**이었고,
# 실키 첫 결제에서 go 주문이 consumer 로 착지해서야 드러났다.
#
# 아래 테스트들은 **`MallReserved` 를 넣지 않는다** — 실전 form 과 같은 모양이다.
# ─────────────────────────────────────────────────────────────────────────────


def _nice_env(monkeypatch):
    """go/consumer 착지 URL 4종을 테스트용으로 고정."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    monkeypatch.setattr(settings, "PAYMENT_SUCCESS_URL", "https://consumer.example/payment/success", raising=False)
    monkeypatch.setattr(settings, "PAYMENT_FAIL_URL", "https://consumer.example/payment/fail", raising=False)
    monkeypatch.setattr(settings, "NICEPAY_GO_SUCCESS_URL", "https://go.example/checkout/nice/success", raising=False)
    monkeypatch.setattr(settings, "NICEPAY_GO_FAIL_URL", "https://go.example/checkout/nice/fail", raising=False)
    _patch_route_db(monkeypatch)


@pytest.mark.asyncio
async def test_return_go_lands_on_go_without_mallreserved(client, db_session, monkeypatch):
    """🔴 핵심: MallReserved 가 **없어도** 원장 센티넬로 go 착지(승인 성공)."""
    _nice_env(monkeypatch)
    from app.services import payment_gateway as pgmod
    nice = pgmod.get_payment_gateway("nicepay")
    _stub_approval(nice, monkeypatch, status="paid")
    monkeypatch.setattr(pgmod, "get_payment_gateway", lambda provider=None: nice)
    monkeypatch.setattr("app.services.payment_service.get_payment_gateway", lambda provider=None: nice)

    go_ref = str(uuid.uuid4())
    await _create_order_bundle(
        db_session, payment_id=None, external_ref=go_ref, total_amount=1004.0,
        payment_metadata={"success_url": "go", "fail_url": "go"},
    )
    await db_session.commit()

    resp = await client.post(
        "/api/v1/payments/nice/return",
        **_euckr_post_kwargs({
            "AuthResultCode": "0000", "TxTid": "nictid_ledger_ok", "AuthToken": "authtok",
            "Moid": go_ref, "MID": _MID, "Amt": "1004",
            "Signature": _returnurl_sig("authtok", "1004"), "NextAppURL": _NEXT_APP_URL,
            # ⚠️ MallReserved 없음 — 실전과 동일
        }),
        follow_redirects=False,
    )
    assert resp.status_code == 302
    loc = resp.headers["location"]
    assert loc.startswith("https://go.example/checkout/nice/success"), loc
    assert "consumer.example" not in loc


@pytest.mark.asyncio
async def test_return_go_failure_lands_on_go_fail_without_mallreserved(client, db_session, monkeypatch):
    """승인 실패도 go 로 떨어진다 — 실패했다고 남의 사이트로 보내지 않는다."""
    _nice_env(monkeypatch)
    go_ref = str(uuid.uuid4())
    await _create_order_bundle(
        db_session, payment_id=None, external_ref=go_ref, total_amount=1004.0,
        payment_metadata={"success_url": "go", "fail_url": "go"},
    )
    await db_session.commit()

    resp = await client.post(
        "/api/v1/payments/nice/return",
        **_euckr_post_kwargs({
            "AuthResultCode": "0000", "TxTid": "t", "AuthToken": "authtok",
            "Moid": go_ref, "MID": _MID, "Amt": "1004",
            "Signature": "deadbeef",  # 서명 불일치 → fail
            "NextAppURL": _NEXT_APP_URL,
        }),
        follow_redirects=False,
    )
    assert resp.status_code == 302
    loc = resp.headers["location"]
    assert loc.startswith("https://go.example/checkout/nice/fail"), loc
    assert "consumer.example" not in loc


@pytest.mark.asyncio
async def test_return_consumer_unaffected_without_mallreserved(client, db_session, monkeypatch):
    """무회귀: 센티넬 없는 consumer 주문은 그대로 consumer 착지."""
    _nice_env(monkeypatch)
    await _create_order_bundle(
        db_session, payment_id="ord_consumer_ledger_a1", total_amount=1004.0,
        payment_metadata={"success_url": "https://consumer.example/payment/success"},
    )
    await db_session.commit()

    resp = await client.post(
        "/api/v1/payments/nice/return",
        **_euckr_post_kwargs({
            "AuthResultCode": "0000", "TxTid": "t", "AuthToken": "authtok",
            "Moid": "ord_consumer_ledger_a1", "MID": _MID, "Amt": "1004",
            "Signature": "deadbeef", "NextAppURL": _NEXT_APP_URL,
        }),
        follow_redirects=False,
    )
    assert resp.status_code == 302
    loc = resp.headers["location"]
    assert loc.startswith("https://consumer.example/payment/fail"), loc
    assert "go.example" not in loc


@pytest.mark.asyncio
async def test_return_go_url_string_is_not_the_sentinel(client, db_session, monkeypatch):
    """🔴 완전일치 계약: success_url 이 `https://go.pickket.kr/...` 여도 go 가 **아니다**.

    consumer 주문도 *.pickket.kr URL 을 적법하게 넣을 수 있다. 판정을
    startswith/contains 로 느슨하게 하면 consumer 주문이 go 로 새어 나간다.
    """
    _nice_env(monkeypatch)
    await _create_order_bundle(
        db_session, payment_id="ord_consumer_gourl_a1", total_amount=1004.0,
        payment_metadata={"success_url": "https://go.pickket.kr/payment/success"},
    )
    await db_session.commit()

    resp = await client.post(
        "/api/v1/payments/nice/return",
        **_euckr_post_kwargs({
            "AuthResultCode": "0000", "TxTid": "t", "AuthToken": "authtok",
            "Moid": "ord_consumer_gourl_a1", "MID": _MID, "Amt": "1004",
            "Signature": "deadbeef", "NextAppURL": _NEXT_APP_URL,
        }),
        follow_redirects=False,
    )
    assert resp.status_code == 302
    loc = resp.headers["location"]
    assert loc.startswith("https://consumer.example/payment/fail"), loc
    assert "go.example" not in loc


@pytest.mark.asyncio
async def test_return_unknown_order_still_redirects(client, db_session, monkeypatch):
    """주문을 못 찾아도 **리다이렉트는 나간다** — 구매자가 빈 화면을 보면 안 된다."""
    _nice_env(monkeypatch)
    resp = await client.post(
        "/api/v1/payments/nice/return",
        **_euckr_post_kwargs({
            "AuthResultCode": "0000", "TxTid": "t", "AuthToken": "authtok",
            "Moid": str(uuid.uuid4()), "MID": _MID, "Amt": "1004",
            "Signature": "deadbeef", "NextAppURL": _NEXT_APP_URL,
        }),
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert resp.headers["location"].startswith("http")
