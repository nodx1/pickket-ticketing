"""M-3 Critical 회귀 테스트 — 환불 정책 게이트 + 이중 환불 방어.

idx0: partial/quantity-refund 엔드포인트가 일반 환불과 동일한 정책 게이트
      (취소 수수료, 이벤트 당일 환불 금지, REFUND_AUTO_APPROVE_LIMIT 승인)를
      타는지 검증.
idx1: PENDING(요청됨·미승인) 환불이 환불 가능액 계산에 반영되고,
      approve_refund 가 승인 시점에 재검증하여 이중 승인/이중 환불을 막는지 검증.
"""

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models.event import Event
from app.models.order import Order, OrderStatus
from app.models.refund import Refund, RefundItem, RefundStatus
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
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
    quantity: int = 1,
    price: float = 50.0,
):
    org_token = await get_auth_token(client, email=org_email, is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 100,
            "base_price": price,
            "sale_mode": "fixed_fcfs",
            "face_price": price,
        },
        headers=auth_headers(org_token),
    )
    assert tier_resp.status_code in (200, 201), tier_resp.text
    tier = tier_resp.json()

    buyer_token = await get_auth_token(client, email=buyer_email)
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={"quantity": quantity},
        headers=auth_headers(buyer_token),
    )
    assert purchase_resp.status_code in (200, 201), purchase_resp.text
    purchase = purchase_resp.json()

    await confirm_purchase_payment(client, buyer_token, purchase["order_id"])
    return buyer_token, event, purchase


async def _set_event_date(event_id: str, event_date: datetime) -> None:
    async with TestSession() as session:
        event = (
            await session.execute(select(Event).where(Event.id == uuid.UUID(event_id)))
        ).scalar_one()
        event.event_date = event_date
        await session.commit()


# ═══════════════════════════════════════════════════════════════════
# idx0 — partial/quantity-refund 정책 게이트 (취소 수수료)
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_quantity_refund_blocked_on_event_day(client, void_calls):
    """이벤트 당일(수수료 100%) → /quantity-refund 도 환불 금지여야 한다."""
    buyer_token, event, purchase = await _setup_confirmed_order(
        client,
        org_email="gate_qty_day_org@test.com",
        buyer_email="gate_qty_day_buyer@test.com",
        quantity=2,
    )
    order_id = purchase["order_id"]
    await _set_event_date(event["id"], datetime.now(timezone.utc) + timedelta(hours=2))

    resp = await client.post(
        f"/api/v1/orders/{order_id}/quantity-refund",
        json={"quantity": 2, "reason": "노쇼 직전 환불 시도"},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 400, resp.text
    assert void_calls == [], "수수료 100% 차단인데 PG가 호출됨"

    async with TestSession() as session:
        tickets = (
            await session.execute(
                select(Ticket).where(Ticket.purchase_order_id == uuid.UUID(order_id))
            )
        ).scalars().all()
        assert all(t.status == TicketStatus.ACTIVE for t in tickets)
        order = (
            await session.execute(select(Order).where(Order.id == uuid.UUID(order_id)))
        ).scalar_one()
        assert float(order.total_refunded) == 0.0


@pytest.mark.asyncio
async def test_partial_refund_blocked_on_event_day(client, void_calls):
    """이벤트 당일 → /partial-refund 도 환불 금지여야 한다."""
    buyer_token, event, purchase = await _setup_confirmed_order(
        client,
        org_email="gate_part_day_org@test.com",
        buyer_email="gate_part_day_buyer@test.com",
        quantity=1,
    )
    order_id = purchase["order_id"]
    await _set_event_date(event["id"], datetime.now(timezone.utc) + timedelta(hours=2))

    resp = await client.post(
        f"/api/v1/orders/{order_id}/partial-refund",
        json={
            "reason": "당일 부분 환불 시도",
            "items": [{"ticket_id": purchase["ticket_ids"][0], "amount": 50.0}],
        },
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 400, resp.text
    assert void_calls == []


@pytest.mark.asyncio
async def test_quantity_refund_applies_cancellation_fee(client, void_calls):
    """5일 전(10% 수수료) → /quantity-refund 환불액에서 수수료가 차감되어야 한다."""
    buyer_token, event, purchase = await _setup_confirmed_order(
        client,
        org_email="gate_qty_fee_org@test.com",
        buyer_email="gate_qty_fee_buyer@test.com",
        quantity=2,
        price=100.0,
    )
    order_id = purchase["order_id"]
    await _set_event_date(
        event["id"], datetime.now(timezone.utc) + timedelta(days=5, hours=12)
    )

    resp = await client.post(
        f"/api/v1/orders/{order_id}/quantity-refund",
        json={"quantity": 1, "reason": "수수료 적용 환불"},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    # 100 − 10%(수수료) = 90
    assert data["refund_amount"] == pytest.approx(90.0)
    assert data["refund_status"] == "completed"

    # PG에도 순액(90)이 부분 취소로 전달
    assert len(void_calls) == 1
    assert void_calls[0]["amount"] == 90

    async with TestSession() as session:
        order = (
            await session.execute(select(Order).where(Order.id == uuid.UUID(order_id)))
        ).scalar_one()
        assert float(order.total_refunded) == pytest.approx(90.0)


# ═══════════════════════════════════════════════════════════════════
# idx0 — partial/quantity-refund 정책 게이트 (승인 한도)
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_partial_refund_over_limit_requires_approval(client, void_calls):
    """자동 승인 한도(50,000) 초과 부분 환불 → PENDING + PG 미호출."""
    buyer_token, _event, purchase = await _setup_confirmed_order(
        client,
        org_email="gate_part_limit_org@test.com",
        buyer_email="gate_part_limit_buyer@test.com",
        quantity=1,
        price=60000.0,
    )
    order_id = purchase["order_id"]

    resp = await client.post(
        f"/api/v1/orders/{order_id}/partial-refund",
        json={
            "reason": "고액 부분 환불",
            "items": [{"ticket_id": purchase["ticket_ids"][0], "amount": 60000.0}],
        },
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["requires_approval"] is True
    assert data["refund_status"] == "pending"
    assert void_calls == [], "승인 전인데 PG가 호출됨"

    async with TestSession() as session:
        refund = (
            await session.execute(
                select(Refund).where(Refund.order_id == uuid.UUID(order_id))
            )
        ).scalar_one()
        assert refund.status == RefundStatus.PENDING
        assert refund.requires_approval is True

        ticket = (
            await session.execute(
                select(Ticket).where(Ticket.purchase_order_id == uuid.UUID(order_id))
            )
        ).scalar_one()
        assert ticket.status == TicketStatus.ACTIVE, "승인 전에 티켓이 취소됨"

        order = (
            await session.execute(select(Order).where(Order.id == uuid.UUID(order_id)))
        ).scalar_one()
        assert float(order.total_refunded) == 0.0

    # admin 승인 → 그제서야 PG 호출 + 완료
    admin_id = uuid.uuid4()
    async with TestSession() as session:
        session.add(
            User(
                id=admin_id,
                email=f"gate_part_limit_admin_{uuid.uuid4().hex[:8]}@test.com",
                hashed_password="hashed",
                name="Gate Admin",
                is_admin=True,
            )
        )
        await session.commit()

    async with TestSession() as session:
        svc = RefundService(session)
        approved = await svc.approve_refund(refund.id, admin_id=admin_id)
        await session.commit()
        assert approved.status == RefundStatus.COMPLETED

    assert len(void_calls) == 1

    async with TestSession() as session:
        order = (
            await session.execute(select(Order).where(Order.id == uuid.UUID(order_id)))
        ).scalar_one()
        assert float(order.total_refunded) == pytest.approx(60000.0)
        ticket = (
            await session.execute(
                select(Ticket).where(Ticket.purchase_order_id == uuid.UUID(order_id))
            )
        ).scalar_one()
        assert ticket.status == TicketStatus.CANCELLED


@pytest.mark.asyncio
async def test_quantity_refund_over_limit_requires_approval(client, void_calls):
    """한도 초과 /quantity-refund 도 PENDING 으로 생성되어야 한다."""
    buyer_token, _event, purchase = await _setup_confirmed_order(
        client,
        org_email="gate_qty_limit_org@test.com",
        buyer_email="gate_qty_limit_buyer@test.com",
        quantity=2,
        price=60000.0,
    )
    order_id = purchase["order_id"]

    resp = await client.post(
        f"/api/v1/orders/{order_id}/quantity-refund",
        json={"quantity": 2, "reason": "고액 수량 환불"},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["requires_approval"] is True
    assert data["refund_status"] == "pending"
    assert void_calls == []


@pytest.mark.asyncio
async def test_quantity_refund_under_limit_still_auto_completes(client, void_calls):
    """한도 이하 + 수수료 0% → 기존처럼 즉시 자동 완료 (회귀 방지)."""
    buyer_token, _event, purchase = await _setup_confirmed_order(
        client,
        org_email="gate_qty_auto_org@test.com",
        buyer_email="gate_qty_auto_buyer@test.com",
        quantity=2,
        price=50.0,
    )
    order_id = purchase["order_id"]

    resp = await client.post(
        f"/api/v1/orders/{order_id}/quantity-refund",
        json={"quantity": 1, "reason": "일부 환불"},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["requires_approval"] is False
    assert data["refund_status"] == "completed"
    assert data["refund_amount"] == pytest.approx(50.0)
    assert len(void_calls) == 1
    assert void_calls[0]["amount"] == 50


# ═══════════════════════════════════════════════════════════════════
# idx1 — PENDING 환불의 환불 가능액 반영 (요청 시점)
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_second_refund_request_blocked_while_pending(client, void_calls):
    """PENDING 환불이 걸린 주문/티켓 → 두 번째 환불 요청은 모든 경로에서 거부."""
    buyer_token, _event, purchase = await _setup_confirmed_order(
        client,
        org_email="gate_dup_req_org@test.com",
        buyer_email="gate_dup_req_buyer@test.com",
        quantity=1,
        price=60000.0,
    )
    order_id = purchase["order_id"]
    ticket_id = purchase["ticket_ids"][0]

    # 1차 요청 → 한도 초과로 PENDING
    first = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "첫 번째 요청"},
        headers=auth_headers(buyer_token),
    )
    assert first.status_code == 200, first.text
    assert first.json()["refund_status"] == "pending"

    # 2차: 일반 환불 경로 → 거부
    second = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "두 번째 요청 (이중 환불 시도)"},
        headers=auth_headers(buyer_token),
    )
    assert second.status_code == 400, second.text

    # 2차: partial-refund 경로 → 거부
    third = await client.post(
        f"/api/v1/orders/{order_id}/partial-refund",
        json={
            "reason": "부분 환불로 우회 시도",
            "items": [{"ticket_id": ticket_id, "amount": 60000.0}],
        },
        headers=auth_headers(buyer_token),
    )
    assert third.status_code == 400, third.text

    # 2차: quantity-refund 경로 → 거부
    fourth = await client.post(
        f"/api/v1/orders/{order_id}/quantity-refund",
        json={"quantity": 1, "reason": "수량 환불로 우회 시도"},
        headers=auth_headers(buyer_token),
    )
    assert fourth.status_code == 400, fourth.text

    assert void_calls == []

    async with TestSession() as session:
        refunds = (
            await session.execute(
                select(Refund).where(Refund.order_id == uuid.UUID(order_id))
            )
        ).scalars().all()
        assert len(refunds) == 1, "PENDING 1건만 존재해야 함"
        assert refunds[0].status == RefundStatus.PENDING


# ═══════════════════════════════════════════════════════════════════
# idx1 — approve_refund 승인 시점 재검증 (이중 승인 차단)
# ═══════════════════════════════════════════════════════════════════


async def _build_order_with_pending_refunds(*, count: int = 2, amount: float = 60000.0):
    """요청 시점 가드를 우회해 PENDING 환불 N건을 직접 적재 (과거 데이터 시뮬레이션)."""
    user_id = uuid.uuid4()
    admin_id = uuid.uuid4()
    event_id = uuid.uuid4()
    tier_id = uuid.uuid4()
    order_id = uuid.uuid4()
    ticket_id = uuid.uuid4()

    async with TestSession() as session:
        from app.models.event import SeatTier

        session.add(
            User(
                id=user_id,
                email=f"dblappr_{uuid.uuid4().hex[:8]}@test.com",
                hashed_password="hashed",
                name="Double Approve",
            )
        )
        session.add(
            User(
                id=admin_id,
                email=f"dblappr_admin_{uuid.uuid4().hex[:8]}@test.com",
                hashed_password="hashed",
                name="Double Approve Admin",
                is_admin=True,
            )
        )
        session.add(
            Event(
                id=event_id,
                organizer_id=user_id,
                title="Double Approval Test",
                slug=f"test-double-approval-{uuid.uuid4().hex[:8]}",
                venue="Venue",
                event_date=datetime.now(timezone.utc) + timedelta(days=30),
                bidding_opens_at=datetime.now(timezone.utc) - timedelta(hours=1),
                bidding_closes_at=datetime.now(timezone.utc) + timedelta(hours=24),
                total_seats=100,
                min_price=10000,
                category="CONCERT",
            )
        )
        session.add(
            SeatTier(
                id=tier_id, event_id=event_id, name="A", capacity=100,
                base_price=amount, sold_count=1,
            )
        )
        session.add(
            Order(
                id=order_id,
                user_id=user_id,
                event_id=event_id,
                tier_id=tier_id,
                status=OrderStatus.CONFIRMED,
                quantity=1,
                unit_price=amount,
                total_amount=amount,
                payment_currency="KRW",
            )
        )
        session.add(
            Ticket(
                id=ticket_id,
                event_id=event_id,
                tier_id=tier_id,
                original_owner_id=user_id,
                current_owner_id=user_id,
                purchase_price=amount,
                sale_mode="fixed_fcfs",
                purchase_order_id=order_id,
                status=TicketStatus.ACTIVE,
            )
        )
        await session.commit()

    async with TestSession() as session:
        refund_ids = []
        for i in range(count):
            refund = Refund(
                order_id=order_id,
                refund_type="full",
                amount=Decimal(str(amount)),
                currency="KRW",
                reason=f"pending refund #{i + 1}",
                initiated_by="user",
                initiated_by_user_id=user_id,
                requires_approval=True,
                status=RefundStatus.PENDING,
            )
            refund.items.append(
                RefundItem(
                    ticket_id=ticket_id,
                    seat_id=None,
                    amount=Decimal(str(amount)),
                    ticket_status_before="active",
                    ticket_status_after="cancelled",
                )
            )
            session.add(refund)
            await session.flush()
            refund_ids.append(refund.id)
        await session.commit()

    return order_id, ticket_id, refund_ids, admin_id


@pytest.mark.asyncio
async def test_approve_refund_double_approval_blocked(client, void_calls):
    """동일 티켓 PENDING 환불 2건 → 첫 승인만 성공, 두 번째 승인은 재검증에서 거부."""
    order_id, ticket_id, refund_ids, admin_id = await _build_order_with_pending_refunds()

    # 1차 승인 → 성공 (payment_id 없는 주문 → mock PG 경로)
    async with TestSession() as session:
        svc = RefundService(session)
        approved = await svc.approve_refund(refund_ids[0], admin_id=admin_id)
        await session.commit()
        assert approved.status == RefundStatus.COMPLETED

    async with TestSession() as session:
        order = (
            await session.execute(select(Order).where(Order.id == order_id))
        ).scalar_one()
        assert float(order.total_refunded) == pytest.approx(60000.0)
        ticket = (
            await session.execute(select(Ticket).where(Ticket.id == ticket_id))
        ).scalar_one()
        assert ticket.status == TicketStatus.CANCELLED

    # 2차 승인 → 승인 시점 재검증(티켓 취소됨 + 가용액 0)에서 거부
    async with TestSession() as session:
        svc = RefundService(session)
        with pytest.raises(RefundError, match="Cannot approve"):
            await svc.approve_refund(refund_ids[1], admin_id=admin_id)
        await session.rollback()

    # 원장 검증: COMPLETED 1건뿐, 두 번째는 여전히 PENDING (수동 reject 대상)
    async with TestSession() as session:
        refunds = (
            await session.execute(select(Refund).where(Refund.order_id == order_id))
        ).scalars().all()
        statuses = sorted(r.status for r in refunds)
        assert statuses == [RefundStatus.COMPLETED, RefundStatus.PENDING]
        order = (
            await session.execute(select(Order).where(Order.id == order_id))
        ).scalar_one()
        assert float(order.total_refunded) == pytest.approx(60000.0)


@pytest.mark.asyncio
async def test_approve_refund_balance_revalidation_without_ticket_overlap(client, void_calls):
    """티켓이 겹치지 않아도(금액 기준) 가용액 초과 승인은 거부되어야 한다."""
    # 주문 60,000 / PENDING 2건(각 60,000) — 1건 승인 후 잔액 0
    order_id, ticket_id, refund_ids, admin_id = await _build_order_with_pending_refunds()

    async with TestSession() as session:
        svc = RefundService(session)
        await svc.approve_refund(refund_ids[0], admin_id=admin_id)
        await session.commit()

    # 두 번째 refund 의 item 을 떼어내 티켓 겹침 없이 금액 재검증만 작동하는지 확인
    async with TestSession() as session:
        items = (
            await session.execute(
                select(RefundItem)
                .join(Refund, Refund.id == RefundItem.refund_id)
                .where(Refund.id == refund_ids[1])
            )
        ).scalars().all()
        for item in items:
            await session.delete(item)
        await session.commit()

    async with TestSession() as session:
        svc = RefundService(session)
        with pytest.raises(RefundError, match="exceeds refundable balance"):
            await svc.approve_refund(refund_ids[1], admin_id=admin_id)
        await session.rollback()
