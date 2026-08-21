"""나이스 카드전용 게이팅(C1) — 서버 강제 회귀 테스트.

계약:
  - events.allowed_pay_methods NULL      → 전 수단 허용(현행 무변).
  - events.allowed_pay_methods=["CARD"]  → CARD 통과, VBANK 거부(400=ValueError).
  - pay_method 미지정(None)              → 게이트웨이 기본 CARD 로 판정.
강제 지점은 PaymentService.initiate_payment 단일 진입점이므로 세 prepare 경로
(회원 orders.py·게스트 guests.py·internal internal_commerce.py)를 한 번에 커버한다.
"""

import uuid

import pytest

from app.models.order import OrderStatus
from app.services.nicepay_gateway import (
    normalize_allowed_pay_methods,
    pay_method_allowed,
)
from app.services.payment_service import PaymentService
from app.tests.test_payment_service import _create_order_bundle


# ── 순수 유닛: 정규화·판정 헬퍼 ─────────────────────────────────────


def test_normalize_none_is_all_allowed():
    assert normalize_allowed_pay_methods(None) is None


def test_normalize_dedups_uppercases_and_filters_garbage():
    assert normalize_allowed_pay_methods(["card", "vbank", "HACK", "card"]) == [
        "CARD",
        "VBANK",
    ]


def test_normalize_empty_is_explicit_deny():
    # 빈 배열/전부 무효는 정책 오염으로 전체 허용에 승격하지 않는다.
    assert normalize_allowed_pay_methods([]) == []
    assert normalize_allowed_pay_methods(["나쁜값"]) == []


def test_normalize_non_list_is_explicit_deny():
    assert normalize_allowed_pay_methods("CARD") == []
    assert normalize_allowed_pay_methods({"CARD": True}) == []


def test_allowed_null_permits_everything():
    assert pay_method_allowed("VBANK", None) is True
    assert pay_method_allowed(None, None) is True


def test_allowed_card_only_rejects_vbank_permits_card():
    assert pay_method_allowed("CARD", ["CARD"]) is True
    assert pay_method_allowed("card", ["CARD"]) is True  # 대소문자 무관
    assert pay_method_allowed("VBANK", ["CARD"]) is False


def test_allowed_unspecified_method_uses_card_default():
    # pay_method None → 게이트웨이 기본 CARD 가 실릴 것이므로 CARD 로 판정.
    assert pay_method_allowed(None, ["CARD"]) is True
    assert pay_method_allowed(None, ["VBANK"]) is False


def test_allowed_garbage_list_is_rejected():
    # 저장값이 오염돼도 전체 허용(fail-open)하지 않는다.
    assert pay_method_allowed("VBANK", ["나쁜값"]) is False


# ── 통합: initiate_payment 서버 강제(세 경로 공통 진입점) ────────────


@pytest.mark.asyncio
async def test_prepare_rejects_disallowed_method_card_only(db_session):
    bundle = await _create_order_bundle(db_session, order_status=OrderStatus.PENDING)
    bundle["event"].allowed_pay_methods = ["CARD"]
    await db_session.flush()

    svc = PaymentService(db_session)
    with pytest.raises(ValueError):
        await svc.initiate_payment(
            bundle["order"].id, idempotency_key="idem_reject", pay_method="VBANK"
        )
    # 주문은 여전히 PENDING(상태 오염 없음 — 검증이 mutation 앞).
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.PENDING


@pytest.mark.asyncio
async def test_prepare_allows_permitted_method_card_only(db_session):
    bundle = await _create_order_bundle(db_session, order_status=OrderStatus.PENDING)
    bundle["event"].allowed_pay_methods = ["CARD"]
    await db_session.flush()

    svc = PaymentService(db_session)
    resp = await svc.initiate_payment(
        bundle["order"].id, idempotency_key="idem_ok", pay_method="CARD"
    )
    assert resp.status == "payment_required"


@pytest.mark.asyncio
async def test_prepare_null_allows_any_method(db_session):
    # NULL = 전체 허용(현행 무변) — VBANK 도 통과.
    bundle = await _create_order_bundle(db_session, order_status=OrderStatus.PENDING)
    assert bundle["event"].allowed_pay_methods is None
    await db_session.flush()

    svc = PaymentService(db_session)
    resp = await svc.initiate_payment(
        bundle["order"].id, idempotency_key="idem_null", pay_method="VBANK"
    )
    assert resp.status == "payment_required"


@pytest.mark.asyncio
async def test_prepare_unspecified_method_rejected_when_card_excluded(db_session):
    # pay_method 미지정 → CARD 기본. 허용목록이 VBANK 뿐이면 거부.
    bundle = await _create_order_bundle(db_session, order_status=OrderStatus.PENDING)
    bundle["event"].allowed_pay_methods = ["VBANK"]
    await db_session.flush()

    svc = PaymentService(db_session)
    with pytest.raises(ValueError):
        await svc.initiate_payment(
            bundle["order"].id, idempotency_key="idem_unspec"
        )
