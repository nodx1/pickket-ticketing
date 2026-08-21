"""go self-checkout 내부 나이스 구형 결제창 prepare 테스트 (feat/nicepay-legacy).

배경: organizer(go) self-checkout 은 서비스토큰으로 go+v2 주문을 write-through 생성하고
{order_id, provider} 만 받는다. 나이스 구형 결제창(goPay)은 서버계산 SignData(=payForm)가
필수인데 go 는 회원/게스트 prepare 를 쓸 수 없어(토큰 미보유) provider_params 를 못 받았다.
이 엔드포인트가 서비스토큰 + external_ref 매칭 + PaymentService.initiate_payment 재사용으로
provider_params 를 반환한다.

커버:
  A) 서비스토큰 정상 + nicepay → provider_params.form(payForm) 반환(회원/게스트와 동일 로직).
  B) 토큰/서명 없음 → 거부(fail-closed, 401).
  C) order_ref 매칭: v2 order id, external_ref(go order id) 둘 다 해석.
  D) pay_method 전달 → PayMethod 정규화(payForm 에 반영).
  E) 미존재 order_ref → 404(enumeration-safe).
  F) 0원 free 주문(생성 시 자동 CONFIRMED) → prepare 400(라이브 구형결제 대상 아님).
  G) 계약 불변: 토스/mock provider → provider_params None(8필드 계약 무변).

test_internal_commerce.py 의 시딩 헬퍼(_seed_organizer/_seed_event_with_tier)를 재사용한다.
"""

import uuid

import pytest

from app.core.config import settings
from app.models.order import Order, OrderStatus

from app.tests.test_internal_commerce import (
    _seed_event_with_tier,
    _seed_organizer,
)

pytestmark = pytest.mark.asyncio

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


@pytest.fixture
def _nicepay_env(monkeypatch):
    """전역 기본 게이트웨이를 nicepay 로(서버계산 payForm 경로). 실키 아님(테스트 상수)."""
    monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "nicepay", raising=False)
    monkeypatch.setattr(settings, "NICE_MID", "nicepay00m", raising=False)
    monkeypatch.setattr(
        settings, "NICE_MERCHANT_KEY", "merchantkey_golden_fixed_0123456789", raising=False
    )
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    monkeypatch.setattr(
        settings, "NICEPAY_RETURN_URL",
        "https://api.pickket.kr/api/v1/payments/nice/return", raising=False,
    )


async def _create_internal_order(
    client, db_session, *, external_id, unit_price=50000, quantity=1
):
    """서비스토큰으로 유료 internal 주문 1건 생성(go self-checkout write-through 재현)."""
    # _seed_event_with_tier→_create_event 는 _event_body 기본 go_account_id="go_org_1" 를 쓴다.
    user = await _seed_organizer(db_session)  # go_account_id="go_org_1"
    eid, tier = await _seed_event_with_tier(
        client, db_session, tier_ref=f"t_{uuid.uuid4().hex[:6]}"
    )
    r = await client.post(
        "/api/v1/internal/orders",
        json={
            "external_order_id": external_id,
            "user_id": str(user.id),
            "event_id": eid,
            "items": [
                {"tier_id": str(tier.id), "quantity": quantity, "unit_price": unit_price}
            ],
            "total_amount": unit_price * quantity,
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    return data["order_id"], external_id, eid


# ════════════════════════════════════════════════════════════════════════
# A) 서비스토큰 정상 + nicepay → provider_params.form 반환
# ════════════════════════════════════════════════════════════════════════

async def test_internal_prepare_nicepay_provider_params(client, db_session, _nicepay_env):
    ext = f"go_order_{uuid.uuid4().hex[:8]}"
    order_id, _, _ = await _create_internal_order(client, db_session, external_id=ext)

    r = await client.post(
        f"/api/v1/internal/orders/{order_id}/payment/prepare",
        json={"success_url": "go", "fail_url": "go", "idempotency_key": "idem_int_pp_a"},
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "nicepay"
    assert body["order_id"] == order_id
    # provider_params.form(payForm) — 서버가 계산한 나이스 구형 결제창 필드.
    assert body["provider_params"] is not None
    form = body["provider_params"]["form"]
    assert form["MID"] == "nicepay00m"
    assert form["Moid"] == body["payment_id"]
    assert form["SignData"]  # 서버 계산 서명(비어있지 않음)
    assert form["ReturnURL"] == "https://api.pickket.kr/api/v1/payments/nice/return"
    # success_url='go' 센티넬 → MallReserved(=v2 return 이 go 랜딩으로 302).
    assert form["MallReserved"] == "go"
    assert body["provider_params"]["js_url"]

    # 주문이 PAYMENT_REQUIRED 로 전이됐는지(커밋됨) 확인.
    order = await db_session.get(Order, uuid.UUID(order_id))
    await db_session.refresh(order)
    assert order.status == OrderStatus.PAYMENT_REQUIRED


# ════════════════════════════════════════════════════════════════════════
# B) 토큰 없음 → 거부(fail-closed)
# ════════════════════════════════════════════════════════════════════════

async def test_internal_prepare_no_token_rejected(client, db_session, _nicepay_env):
    ext = f"go_order_{uuid.uuid4().hex[:8]}"
    order_id, _, _ = await _create_internal_order(client, db_session, external_id=ext)

    # 헤더 없음(서명·토큰 둘 다 없음) → _internal_auth 가 401.
    r = await client.post(
        f"/api/v1/internal/orders/{order_id}/payment/prepare",
        json={"success_url": "go", "fail_url": "go"},
    )
    assert r.status_code == 401, r.text


async def test_internal_prepare_bad_token_rejected(client, db_session, _nicepay_env):
    ext = f"go_order_{uuid.uuid4().hex[:8]}"
    order_id, _, _ = await _create_internal_order(client, db_session, external_id=ext)

    r = await client.post(
        f"/api/v1/internal/orders/{order_id}/payment/prepare",
        json={"success_url": "go", "fail_url": "go"},
        headers={"x-pickket-service-token": "wrong-token"},
    )
    assert r.status_code == 401, r.text


# ════════════════════════════════════════════════════════════════════════
# C) order_ref 매칭 — external_ref(go order id)로도 해석
# ════════════════════════════════════════════════════════════════════════

async def test_internal_prepare_matches_by_external_ref(client, db_session, _nicepay_env):
    ext = f"go_order_{uuid.uuid4().hex[:8]}"
    order_id, external_id, _ = await _create_internal_order(
        client, db_session, external_id=ext
    )

    # order_ref = external_ref(go order id) — v2 order id 가 아니어도 매칭돼야 한다.
    r = await client.post(
        f"/api/v1/internal/orders/{external_id}/payment/prepare",
        json={"success_url": "go", "fail_url": "go", "idempotency_key": "idem_int_pp_c"},
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # external_ref 로 조회해도 동일 v2 주문을 반환.
    assert body["order_id"] == order_id
    assert body["provider"] == "nicepay"
    assert body["provider_params"]["form"]["MID"] == "nicepay00m"


# ════════════════════════════════════════════════════════════════════════
# D) pay_method 전달 → PayMethod 정규화
# ════════════════════════════════════════════════════════════════════════

async def test_internal_prepare_pay_method_passthrough(client, db_session, _nicepay_env):
    ext = f"go_order_{uuid.uuid4().hex[:8]}"
    order_id, _, _ = await _create_internal_order(client, db_session, external_id=ext)

    r = await client.post(
        f"/api/v1/internal/orders/{order_id}/payment/prepare",
        json={
            "success_url": "go", "fail_url": "go",
            "pay_method": "VBANK", "idempotency_key": "idem_int_pp_d",
        },
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    form = r.json()["provider_params"]["form"]
    # 게이트웨이가 화이트리스트 정규화한 PayMethod 가 payForm 에 실린다.
    assert form["PayMethod"] == "VBANK"


# ════════════════════════════════════════════════════════════════════════
# E) 미존재 order_ref → 404(enumeration-safe)
# ════════════════════════════════════════════════════════════════════════

async def test_internal_prepare_unknown_order_404(client, db_session, _nicepay_env):
    r = await client.post(
        f"/api/v1/internal/orders/{uuid.uuid4()}/payment/prepare",
        json={"success_url": "go", "fail_url": "go"},
        headers=_HDR,
    )
    assert r.status_code == 404, r.text
    assert r.json()["error"]["code"] == "ORDER_NOT_FOUND"


async def test_internal_prepare_unknown_external_ref_404(client, db_session, _nicepay_env):
    r = await client.post(
        "/api/v1/internal/orders/go_nonexistent_ref/payment/prepare",
        json={"success_url": "go", "fail_url": "go"},
        headers=_HDR,
    )
    assert r.status_code == 404, r.text
    assert r.json()["error"]["code"] == "ORDER_NOT_FOUND"


# ════════════════════════════════════════════════════════════════════════
# F) 0원 free 주문(생성 시 자동 CONFIRMED) → prepare 400(라이브 구형결제 대상 아님)
# ════════════════════════════════════════════════════════════════════════

async def test_internal_prepare_free_order_rejected(client, db_session, _nicepay_env):
    from sqlalchemy import select as _select
    from app.models.event import SeatTier
    from app.tests.test_internal_commerce import _create_event

    # 0원(무료) tier 를 별도 시드 — base_price=0 → floor 0 → unit_price=0 통과.
    from datetime import datetime, timedelta, timezone
    _now = datetime.now(timezone.utc)
    user = await _seed_organizer(db_session)  # go_account_id="go_org_1"(_event_body 기본)
    eid = await _create_event(
        client,
        status="live",
        sale_window={
            "opens_at": (_now - timedelta(days=1)).isoformat(),
            "closes_at": (_now + timedelta(days=7)).isoformat(),
        },
    )
    tref = f"tfree_{uuid.uuid4().hex[:6]}"
    await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [{"external_ref": tref, "name": "무료", "capacity": 100,
                         "base_price": 0, "sale_mode": "fixed_fcfs"}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    tier = (await db_session.execute(
        _select(SeatTier).where(SeatTier.external_ref == tref)
    )).scalar_one()

    ext = f"go_order_{uuid.uuid4().hex[:8]}"
    r = await client.post(
        "/api/v1/internal/orders",
        json={
            "external_order_id": ext,
            "user_id": str(user.id),
            "event_id": eid,
            "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 0}],
            "total_amount": 0,
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    order_id = r.json()["data"]["order_id"]
    # 0원 주문은 생성 시 자동 CONFIRMED → PENDING/PAYMENT_REQUIRED 아님 → initiate 불가(400).
    order = await db_session.get(Order, uuid.UUID(order_id))
    assert order.status == OrderStatus.CONFIRMED

    r2 = await client.post(
        f"/api/v1/internal/orders/{order_id}/payment/prepare",
        json={"success_url": "go", "fail_url": "go"},
        headers=_HDR,
    )
    assert r2.status_code == 400, r2.text


# ════════════════════════════════════════════════════════════════════════
# G) 계약 불변 — 토스/mock provider → provider_params None(8필드 계약 무변)
# ════════════════════════════════════════════════════════════════════════

async def test_internal_prepare_non_nicepay_provider_params_none(client, db_session, monkeypatch):
    # 전역 기본 게이트웨이를 토스(=nicepay 아님)로. provider_params 미부착.
    monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "toss", raising=False)
    ext = f"go_order_{uuid.uuid4().hex[:8]}"
    order_id, _, _ = await _create_internal_order(client, db_session, external_id=ext)

    r = await client.post(
        f"/api/v1/internal/orders/{order_id}/payment/prepare",
        json={
            "success_url": "https://www.pickket.kr/pay/success",
            "fail_url": "https://www.pickket.kr/pay/fail",
            "idempotency_key": "idem_int_pp_g",
        },
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] != "nicepay"
    assert body["provider_params"] is None


# ════════════════════════════════════════════════════════════════════════
# 🔴 마지막 방어선 — 결제를 걸 수 없는 주문에는 prepare 가 거절한다
#
# 2026-08-08 실장애: 원자주문 dedup 이 만료 주문을 재생했고 **이 가드가 그걸 막았다**.
# 막은 것 자체는 옳다 — 문제는 dedup 이 애초에 그런 주문을 준 것이다(그쪽을 고쳤다).
#
# 🔴 이 가드는 dedup 수정과 **독립적으로** 남아야 한다. 다른 경로(수동 주문·재시도·
#    내부 도구)가 같은 실수를 해도 여기서 멎어야 한다. 두 겹이라 안전한 것이지,
#    한쪽을 고쳤다고 다른 쪽을 걷어내면 방어가 한 겹이 된다.
# ════════════════════════════════════════════════════════════════════════

async def _expect_initiate_refused(db_session, order_id, status):
    """🔴 **이 가드**를 직접 겨눈다 — 서비스 메서드를 부른다.

    ⚠️ 라우트로만 재현하면 안 된다. 상태 전이 검증 등 **다른 가드**가 먼저 막아서
       `status_code >= 400` 이 그대로 통과한다 — 가드를 통째로 지워도 초록이다.
       (실제로 처음에 그렇게 썼고, 뮤테이션 V4 가 살아남아 잡혔다.)
    """
    import pytest as _pytest

    from app.services.payment_service import PaymentService

    order = await db_session.get(Order, uuid.UUID(order_id))
    order.status = status
    await db_session.commit()

    svc = PaymentService(db_session)
    with _pytest.raises(ValueError) as exc:
        await svc.initiate_payment(
            uuid.UUID(order_id),
            success_url="https://x/s",
            fail_url="https://x/f",
        )
    msg = str(exc.value)
    # 🔴 **이 가드의 문구**로 좁힌다. 상태 문자열만 보면 안 된다 —
    #    가드를 지워도 `validate_order_transition` 이
    #    "Invalid order status transition: expired → payment_required" 를 내고,
    #    거기에도 "expired" 가 들어 있어 단언이 그대로 통과한다(V4 가 두 번 살아남았다).
    assert "Cannot initiate payment for order in status" in msg, msg
    # 문구에 어떤 상태였는지도 들어가야 운영이 로그만 보고 원인을 안다(prod 로그 그대로)
    assert status.value in msg, msg
    return order


async def test_prepare_rejects_expired_order(client, db_session, _nicepay_env):
    """🔴 만료 주문에는 결제를 걸 수 없다 — prod 로그의 그 ValueError 자리."""
    ext = f"go_order_{uuid.uuid4().hex[:8]}"
    order_id, _, _ = await _create_internal_order(client, db_session, external_id=ext)
    order = await _expect_initiate_refused(db_session, order_id, OrderStatus.EXPIRED)

    # 라우트로도 새지 않는다
    r = await client.post(
        f"/api/v1/internal/orders/{order_id}/payment/prepare",
        json={"success_url": "go", "fail_url": "go", "idempotency_key": "idem_exp_guard"},
        headers=_HDR,
    )
    assert r.status_code >= 400, f"🔴 만료 주문에 결제창이 열렸다: {r.text}"
    await db_session.refresh(order)
    assert order.status == OrderStatus.EXPIRED, "거절했는데 상태가 움직였다"


async def test_prepare_rejects_cancelled_order(client, db_session, _nicepay_env):
    """취소 주문도 마찬가지."""
    ext = f"go_order_{uuid.uuid4().hex[:8]}"
    order_id, _, _ = await _create_internal_order(client, db_session, external_id=ext)
    await _expect_initiate_refused(db_session, order_id, OrderStatus.CANCELLED)

    r = await client.post(
        f"/api/v1/internal/orders/{order_id}/payment/prepare",
        json={"success_url": "go", "fail_url": "go", "idempotency_key": "idem_can_guard"},
        headers=_HDR,
    )
    assert r.status_code >= 400, f"🔴 취소 주문에 결제창이 열렸다: {r.text}"


async def test_prepare_rejects_already_paid_order(client, db_session, _nicepay_env):
    """🔴 이미 결제된 주문에 결제창을 새로 열면 **이중과금**이다.

    dedup 은 이 주문을 재생한다(그래야 이중과금을 막는다). 재생된 주문으로 결제를 다시
    걸려는 시도는 **여기서** 멎어야 한다 — 두 장치의 역할이 다르다.
    """
    ext = f"go_order_{uuid.uuid4().hex[:8]}"
    order_id, _, _ = await _create_internal_order(client, db_session, external_id=ext)
    await _expect_initiate_refused(db_session, order_id, OrderStatus.PAID)

    r = await client.post(
        f"/api/v1/internal/orders/{order_id}/payment/prepare",
        json={"success_url": "go", "fail_url": "go", "idempotency_key": "idem_paid_guard"},
        headers=_HDR,
    )
    assert r.status_code >= 400, f"🔴 결제된 주문에 결제창이 다시 열렸다: {r.text}"
