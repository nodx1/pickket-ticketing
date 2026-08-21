"""M-3 Blocker #3 회귀 테스트 — 부분/수수료 차감 환불이 PG에 정확한 금액으로 전달되는지.

결함: gateway 취소 호출에 amount 미전달 → PortOne은 전액 취소 실행,
장부에는 부분/수수료 차감 금액만 기록되어 원장 파손.

검증 항목:
1. 부분 환불(ticket_ids 지정) → void_authorization 에 정확한 부분 금액 전달
2. 전액 환불 → amount=None (전액 취소, 후방 호환)
3. 취소 수수료 차감 환불 → 수수료 차감 후 순액 전달
4. PartialRefundService 경로 → 부분 금액 전달
5. 과환불(요청액 > 결제액 − 기환불액) → gateway 호출 전에 거부
"""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models.order import Order
from app.models.refund import Refund, RefundStatus
from app.services.partial_refund_service import (
    PartialRefundError,
    PartialRefundService,
)
from app.services.payment_gateway import VoidResult
from app.services.toss_gateway import TossGateway
from app.services.refund_service import RefundError, RefundService
from app.core.config import settings
from app.tests.conftest import (
    TestSession,
    auth_headers,
    confirm_purchase_payment,
    create_event_as_organizer,
    get_auth_token,
)


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


@pytest.fixture
def void_calls(monkeypatch):
    """PortOneGateway.void_authorization 호출을 기록하는 스파이."""
    calls: list[dict] = []

    async def _fake_void(self, *, payment_id: str, reason: str, amount: int | None = None):
        calls.append({"payment_id": payment_id, "reason": reason, "amount": amount})
        raw: dict = {"mode": "mock", "status": "cancelled", "reason": reason}
        if amount is not None:
            raw["amount"] = int(amount)
        return VoidResult(
            provider="toss",
            payment_id=payment_id,
            voided=True,
            raw=raw,
        )

    monkeypatch.setattr(TossGateway, "void_authorization", _fake_void)
    return calls


async def _setup_confirmed_order(
    client,
    *,
    org_email: str,
    buyer_email: str,
    quantity: int = 2,
):
    org_token = await get_auth_token(client, email=org_email, is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 100,
            "base_price": 50.0,
            "sale_mode": "fixed_fcfs",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    assert tier_resp.status_code in (200, 201)
    tier = tier_resp.json()

    buyer_token = await get_auth_token(client, email=buyer_email)
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={"quantity": quantity},
        headers=auth_headers(buyer_token),
    )
    assert purchase_resp.status_code in (200, 201)
    purchase = purchase_resp.json()

    await confirm_purchase_payment(client, buyer_token, purchase["order_id"])
    return buyer_token, purchase


@pytest.mark.asyncio
async def test_partial_refund_calls_pg_with_exact_amount(client, void_calls):
    """티켓 1장(50) 부분 환불 → PG 취소에 amount=50 이 전달되어야 한다 (전액 취소 금지)."""
    buyer_token, purchase = await _setup_confirmed_order(
        client,
        org_email="pgamt_part_org@test.com",
        buyer_email="pgamt_part_buyer@test.com",
    )
    order_id = purchase["order_id"]

    resp = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={
            "reason": "부분 환불",
            "amount": 50.0,
            "ticket_ids": [purchase["ticket_ids"][0]],
        },
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200, resp.text

    assert len(void_calls) == 1
    call = void_calls[0]
    assert call["payment_id"], "payment_id 없이 PG 취소 호출됨"
    # 핵심: 부분 환불은 전액 취소(None)가 아니라 정확한 부분 금액으로 호출
    assert call["amount"] == 50

    async with TestSession() as session:
        order = (
            await session.execute(select(Order).where(Order.id == uuid.UUID(order_id)))
        ).scalar_one()
        assert float(order.total_refunded) == pytest.approx(50.0)


@pytest.mark.asyncio
async def test_full_refund_calls_pg_with_none_amount(client, void_calls):
    """전액 환불 → amount=None(전액 취소)으로 호출 (후방 호환 의미 유지)."""
    buyer_token, purchase = await _setup_confirmed_order(
        client,
        org_email="pgamt_full_org@test.com",
        buyer_email="pgamt_full_buyer@test.com",
    )
    order_id = purchase["order_id"]

    resp = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "전액 환불"},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200, resp.text

    assert len(void_calls) == 1
    assert void_calls[0]["amount"] is None


@pytest.mark.asyncio
async def test_fee_deducted_refund_passes_net_amount_to_pg(client, void_calls, monkeypatch):
    """취소 수수료 20% 차감 환불 → PG에는 순액(80%)만 취소 요청해야 한다.

    종전 결함: 장부는 80 환불로 기록하면서 PG는 100 전액 취소 → 수수료 수익 유실.
    """
    monkeypatch.setattr(
        RefundService,
        "calculate_cancellation_fee_pct",
        staticmethod(lambda **kwargs: 20.0),
    )

    buyer_token, purchase = await _setup_confirmed_order(
        client,
        org_email="pgamt_fee_org@test.com",
        buyer_email="pgamt_fee_buyer@test.com",
    )
    order_id = purchase["order_id"]
    total = purchase["total_price"]  # 100.0 (50 × 2)

    resp = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "수수료 차감 환불"},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200, resp.text

    expected_net = int(Decimal(str(total)) * Decimal("0.8"))  # 80
    assert len(void_calls) == 1
    assert void_calls[0]["amount"] == expected_net

    async with TestSession() as session:
        refund = (
            await session.execute(
                select(Refund).where(Refund.order_id == uuid.UUID(order_id))
            )
        ).scalar_one()
        assert refund.status == RefundStatus.COMPLETED
        assert float(refund.amount) == pytest.approx(float(expected_net))
        order = (
            await session.execute(select(Order).where(Order.id == uuid.UUID(order_id)))
        ).scalar_one()
        # 장부 환불액 == PG 취소액 (원장 정합)
        assert float(order.total_refunded) == pytest.approx(float(expected_net))


@pytest.mark.asyncio
async def test_partial_refund_service_endpoint_passes_amount(client, void_calls):
    """PartialRefundService 경로(/partial-refund) → 아이템 금액이 PG에 전달."""
    buyer_token, purchase = await _setup_confirmed_order(
        client,
        org_email="pgamt_svc_org@test.com",
        buyer_email="pgamt_svc_buyer@test.com",
    )
    order_id = purchase["order_id"]

    resp = await client.post(
        f"/api/v1/orders/{order_id}/partial-refund",
        json={
            "reason": "아이템 부분 환불",
            "items": [{"ticket_id": purchase["ticket_ids"][0], "amount": 50.0}],
        },
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200, resp.text

    assert len(void_calls) == 1
    assert void_calls[0]["amount"] == 50


@pytest.mark.asyncio
async def test_over_refund_rejected_before_pg_call_refund_service(client, void_calls):
    """환불 요청액 > (결제액 − 기환불액) → gateway 호출 전에 거부 + FAILED."""
    _, purchase = await _setup_confirmed_order(
        client,
        org_email="pgamt_over_org@test.com",
        buyer_email="pgamt_over_buyer@test.com",
    )
    order_id = uuid.UUID(purchase["order_id"])

    async with TestSession() as session:
        order = (
            await session.execute(select(Order).where(Order.id == order_id))
        ).scalar_one()
        refund = Refund(
            order_id=order_id,
            refund_type="partial",
            amount=Decimal(str(order.total_amount)) + Decimal("100"),
            currency="KRW",
            reason="over-refund attempt",
            initiated_by="user",
            status=RefundStatus.APPROVED,
        )
        session.add(refund)
        await session.flush()

        service = RefundService(session)
        with pytest.raises(RefundError, match="exceeds refundable"):
            await service._process_pg_refund(refund, order, [])

        assert refund.status == RefundStatus.FAILED
        await session.rollback()

    # PG는 단 한 번도 호출되지 않아야 한다
    assert void_calls == []


@pytest.mark.asyncio
async def test_over_refund_rejected_before_pg_call_partial_service(client, void_calls):
    """PartialRefundService 도 동일하게 gateway 호출 전 과환불 거부."""
    _, purchase = await _setup_confirmed_order(
        client,
        org_email="pgamt_over2_org@test.com",
        buyer_email="pgamt_over2_buyer@test.com",
    )
    order_id = uuid.UUID(purchase["order_id"])

    async with TestSession() as session:
        order = (
            await session.execute(select(Order).where(Order.id == order_id))
        ).scalar_one()
        refund = Refund(
            order_id=order_id,
            refund_type="partial",
            amount=Decimal(str(order.total_amount)) + Decimal("100"),
            currency="KRW",
            reason="over-refund attempt",
            initiated_by="admin",
            status=RefundStatus.APPROVED,
        )
        session.add(refund)
        await session.flush()

        service = PartialRefundService(session)
        with pytest.raises(PartialRefundError, match="초과"):
            await service._process_pg_partial_refund(refund, order, [])

        assert refund.status == RefundStatus.FAILED
        await session.rollback()

    assert void_calls == []


# ── 🔴 PG 거절(voided=False)을 환불 성공으로 확정하지 않는다 ────────────────────
#
# PG 는 거절을 **예외가 아니라 반환값**으로 알린다(nicepay: HTTP 200 + 실패 ResultCode
# → `voided=False`, raise 없음). 종전에는 세 호출부가 예외만 잡고 `voided` 를 보지 않아
# **돈은 PG 에 남았는데 원장은 환불완료**가 되고 티켓 취소·재고 환원까지 진행됐다.


@pytest.fixture
def void_rejected(monkeypatch):
    """PG 가 취소를 거절하는 상황 — 예외 없이 voided=False 를 반환한다."""
    calls: list[dict] = []

    async def _fake_void(self, *, payment_id: str, reason: str, amount: int | None = None, **kw):
        calls.append({"payment_id": payment_id, "amount": amount})
        return VoidResult(
            provider="toss",
            payment_id=payment_id,
            voided=False,  # ← 거절. raise 하지 않는다.
            raw={"mode": "mock", "status": "failed", "message": "취소 불가 시간대"},
        )

    monkeypatch.setattr(TossGateway, "void_authorization", _fake_void)
    return calls


@pytest.mark.asyncio
async def test_full_refund_rejected_by_pg_does_not_complete(client, void_rejected, db_session):
    """전액 환불에서 PG 가 거절하면 환불이 확정되지 않고 원장이 그대로여야 한다."""
    buyer_token, purchase = await _setup_confirmed_order(
        client,
        org_email="pgvoid_full_org@test.com",
        buyer_email="pgvoid_full_buyer@test.com",
    )
    order_id = purchase["order_id"]

    resp = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "전액 환불"},
        headers=auth_headers(buyer_token),
    )
    # PG 가 거절했으므로 성공(2xx)으로 끝나면 안 된다.
    assert resp.status_code >= 400, resp.text
    assert void_rejected, "PG 취소가 시도되긴 해야 한다"

    # 🔴 원장이 그대로여야 한다 — "돈은 안 나갔는데 환불완료" 금지.
    order = (await db_session.execute(
        select(Order).where(Order.id == uuid.UUID(order_id))
    )).scalar_one()
    await db_session.refresh(order)
    assert float(order.total_refunded or 0) == 0.0
    completed = (await db_session.execute(
        select(Refund).where(
            Refund.order_id == uuid.UUID(order_id),
            Refund.status == RefundStatus.COMPLETED,
        )
    )).scalars().all()
    assert completed == [], "거절된 환불이 COMPLETED 로 남으면 안 된다"


@pytest.mark.asyncio
async def test_partial_refund_rejected_by_pg_does_not_complete(client, void_rejected, db_session):
    """PartialRefundService 경로에서도 동일 — 거절이면 확정 금지.

    ⚠️ `/refund` 는 RefundService 를, `/partial-refund` 는 PartialRefundService 를 탄다.
    두 서비스가 각자 PG 를 부르므로 **엔드포인트를 나눠서** 검증해야 한다
    (`/refund` 로만 검증하면 PartialRefundService 의 검사를 지워도 테스트가 통과한다 — 실측 확인).
    """
    buyer_token, purchase = await _setup_confirmed_order(
        client,
        org_email="pgvoid_part_org@test.com",
        buyer_email="pgvoid_part_buyer@test.com",
    )
    order_id = purchase["order_id"]

    resp = await client.post(
        f"/api/v1/orders/{order_id}/partial-refund",
        json={
            "reason": "부분 환불",
            "items": [{"ticket_id": purchase["ticket_ids"][0], "amount": 50.0}],
        },
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code >= 400, resp.text
    assert void_rejected, "PartialRefundService 가 PG 취소를 시도해야 한다"

    order = (await db_session.execute(
        select(Order).where(Order.id == uuid.UUID(order_id))
    )).scalar_one()
    await db_session.refresh(order)
    assert float(order.total_refunded or 0) == 0.0
