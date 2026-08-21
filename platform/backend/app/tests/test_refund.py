import uuid

import pytest
from sqlalchemy import select

from app.models.audit_log import AuditLog
from app.models.event import Event
from app.models.order import Order, OrderStatus
from app.models.refund import Refund, RefundStatus
from app.models.ticket import Ticket, TicketStatus
from app.tests.conftest import (
    TestSession,
    auth_headers,
    confirm_purchase_payment,
    create_event_as_organizer,
    get_auth_token,
)


async def _setup_purchase(
    client,
    *,
    org_email: str = "refund_org@test.com",
    buyer_email: str = "refund_buyer@test.com",
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

    return org_token, buyer_token, event, tier, purchase


@pytest.mark.asyncio
async def test_full_refund_success(client):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(
        client,
        org_email="refund_full_org@test.com",
        buyer_email="refund_full_buyer@test.com",
    )
    order_id = purchase["order_id"]
    await confirm_purchase_payment(client, buyer_token, order_id)

    reason = "결제 취소 요청"
    resp = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": reason},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "refunded"
    assert data["order_id"] == order_id
    assert data["refund_amount"] == pytest.approx(purchase["total_price"])
    assert data["original_amount"] == pytest.approx(purchase["total_price"])
    assert data["reason"] == reason
    assert data["refunded_at"] is not None

    async with TestSession() as session:
        order = (
            await session.execute(select(Order).where(Order.id == uuid.UUID(order_id)))
        ).scalar_one()
        assert order.status == OrderStatus.REFUNDED


@pytest.mark.asyncio
async def test_partial_refund_success(client, allow_partial_cancel):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(
        client,
        org_email="refund_partial_org@test.com",
        buyer_email="refund_partial_buyer@test.com",
    )
    order_id = purchase["order_id"]
    await confirm_purchase_payment(client, buyer_token, order_id)

    reason = "부분 환불 요청"
    refund_ticket_id = purchase["ticket_ids"][0]
    refund_amount = 50.0
    resp = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": reason, "amount": refund_amount, "ticket_ids": [refund_ticket_id]},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "confirmed"
    assert data["refund_status"] == "completed"
    assert data["refund_amount"] == pytest.approx(refund_amount)
    assert data["original_amount"] == pytest.approx(purchase["total_price"])
    assert data["ticket_ids"] == [refund_ticket_id]

    async with TestSession() as session:
        order = (
            await session.execute(select(Order).where(Order.id == uuid.UUID(order_id)))
        ).scalar_one()
        assert order.status == OrderStatus.CONFIRMED
        assert float(order.total_refunded) == pytest.approx(refund_amount)

        refund = (
            await session.execute(select(Refund).where(Refund.order_id == uuid.UUID(order_id)))
        ).scalar_one()
        assert refund.status == RefundStatus.COMPLETED
        assert float(refund.amount) == pytest.approx(refund_amount)

        tickets = (
            await session.execute(select(Ticket).where(Ticket.purchase_order_id == uuid.UUID(order_id)))
        ).scalars().all()
        statuses = {str(ticket.id): ticket.status for ticket in tickets}
        assert statuses[refund_ticket_id] == TicketStatus.CANCELLED
        assert list(statuses.values()).count(TicketStatus.ACTIVE) == 1


@pytest.mark.asyncio
async def test_refund_already_refunded(client):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(
        client,
        org_email="refund_dupe_org@test.com",
        buyer_email="refund_dupe_buyer@test.com",
    )
    order_id = purchase["order_id"]
    await confirm_purchase_payment(client, buyer_token, order_id)

    first = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "첫 환불"},
        headers=auth_headers(buyer_token),
    )
    assert first.status_code == 200

    second = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "중복 환불"},
        headers=auth_headers(buyer_token),
    )
    assert second.status_code == 400
    detail = second.json().get("detail")
    if isinstance(detail, dict):
        assert "refunded" in str(detail["message"]).lower()
    else:
        assert "refunded" in str(detail).lower()


@pytest.mark.asyncio
async def test_refund_pending_order(client):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(
        client,
        org_email="refund_pending_org@test.com",
        buyer_email="refund_pending_buyer@test.com",
    )
    order_id = purchase["order_id"]

    async with TestSession() as session:
        order = (
            await session.execute(select(Order).where(Order.id == uuid.UUID(order_id)))
        ).scalar_one()
        order.status = OrderStatus.PENDING
        await session.commit()

    resp = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "대기 상태 환불 시도"},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_refund_other_user_order(client):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(
        client,
        org_email="refund_forbidden_org@test.com",
        buyer_email="refund_owner@test.com",
    )
    order_id = purchase["order_id"]
    await confirm_purchase_payment(client, buyer_token, order_id)

    other_token = await get_auth_token(client, email="refund_other_user@test.com")
    resp = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "다른 사용자 환불 시도"},
        headers=auth_headers(other_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_refund_audit_log(client):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(
        client,
        org_email="refund_audit_org@test.com",
        buyer_email="refund_audit_buyer@test.com",
    )
    order_id = purchase["order_id"]
    await confirm_purchase_payment(client, buyer_token, order_id)

    refund_reason = "감사 로그 검증"
    resp = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": refund_reason},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200

    async with TestSession() as session:
        result = await session.execute(
            select(AuditLog).where(AuditLog.action.in_(["refund.auto_approved", "refund.requested"]))
        )
        entries = result.scalars().all()
        assert entries
        matched = False
        for entry in entries:
            if not isinstance(entry.new_value, dict):
                continue
            if entry.new_value.get("order_id") == order_id:
                assert entry.new_value.get("reason") == refund_reason
                assert entry.new_value.get("is_partial") is False
                matched = True
                break
        assert matched


@pytest.mark.asyncio
async def test_get_my_refunds(client, allow_partial_cancel):
    org_token, buyer_token, event, _tier, purchase_1 = await _setup_purchase(
        client,
        org_email="refund_history_org@test.com",
        buyer_email="refund_history_buyer@test.com",
        quantity=1,
    )
    order_id_1 = purchase_1["order_id"]

    tier_2_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "R",
            "capacity": 100,
            "base_price": 50.0,
            "sale_mode": "fixed_fcfs",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    assert tier_2_resp.status_code in (200, 201)
    tier_2 = tier_2_resp.json()

    second_purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_2['id']}/purchase",
        json={"quantity": 2},
        headers=auth_headers(buyer_token),
    )
    assert second_purchase_resp.status_code in (200, 201)
    purchase_2 = second_purchase_resp.json()
    order_id_2 = purchase_2["order_id"]

    await confirm_purchase_payment(client, buyer_token, order_id_1)
    await confirm_purchase_payment(client, buyer_token, order_id_2)

    full_refund_resp = await client.post(
        f"/api/v1/orders/{order_id_1}/refund",
        json={"reason": "전액 환불"},
        headers=auth_headers(buyer_token),
    )
    assert full_refund_resp.status_code == 200

    partial_refund_resp = await client.post(
        f"/api/v1/orders/{order_id_2}/refund",
        json={
            "reason": "부분 환불",
            "amount": 50.0,
            "ticket_ids": [purchase_2["ticket_ids"][0]],
        },
        headers=auth_headers(buyer_token),
    )
    assert partial_refund_resp.status_code == 200

    history_resp = await client.get(
        "/api/v1/orders/my/refunds",
        headers=auth_headers(buyer_token),
    )
    assert history_resp.status_code == 200
    rows = history_resp.json()
    refunded_ids = {row["id"] for row in rows}
    assert order_id_1 in refunded_ids
    assert order_id_2 in refunded_ids


async def _enable_resale_on_event(event_id: str) -> None:
    """이벤트에 재판매 설정을 직접 활성화 (테스트 DB)."""
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    async with TestSession() as session:
        event = (
            await session.execute(select(Event).where(Event.id == uuid.UUID(event_id)))
        ).scalar_one()
        event.resale_enabled = True
        event.resale_max_markup_pct = 50.0
        event.resale_royalty_pct = 10.0
        event.resale_opens_at = now - timedelta(hours=1)
        event.resale_closes_at = now + timedelta(days=7)
        await session.commit()


@pytest.mark.asyncio
async def test_refund_cancels_active_resale_listing(client):
    """결함1: 환불로 티켓이 CANCELLED 되면 그 티켓의 ACTIVE 재판매 listing 도
    같은 트랜잭션에서 CANCELLED 로 전이돼야 한다.

    수정 전엔 listing 이 ACTIVE 로 잔존 → 매칭 배치 churn + 유령 ask 노출.
    """
    from app.models.resale import ResaleListingModel, ResaleListingStatus

    _, buyer_token, _event, tier, purchase = await _setup_purchase(
        client,
        org_email="refund_resale_org@test.com",
        buyer_email="refund_resale_buyer@test.com",
        quantity=1,
    )
    order_id = purchase["order_id"]
    ticket_id = purchase["ticket_ids"][0]
    await confirm_purchase_payment(client, buyer_token, order_id)

    # 재판매 활성화 후 ACTIVE listing 등록 (face_price=50 → markup 한도 내 60)
    await _enable_resale_on_event(_event["id"])
    listing_resp = await client.post(
        "/api/v1/resale/listings",
        json={"ticket_id": ticket_id, "asking_price": 60.0},
        headers=auth_headers(buyer_token),
    )
    assert listing_resp.status_code in (200, 201), listing_resp.text
    assert listing_resp.json()["status"] == "active"

    # 원 구매 전액 환불
    refund_resp = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "재판매 등록 후 원구매 환불"},
        headers=auth_headers(buyer_token),
    )
    assert refund_resp.status_code == 200, refund_resp.text

    async with TestSession() as session:
        ticket = (
            await session.execute(select(Ticket).where(Ticket.id == uuid.UUID(ticket_id)))
        ).scalar_one()
        assert ticket.status == TicketStatus.CANCELLED

        listing = (
            await session.execute(
                select(ResaleListingModel).where(
                    ResaleListingModel.ticket_id == uuid.UUID(ticket_id)
                )
            )
        ).scalar_one()
        # 핵심 검증: ACTIVE 잔존이 아니라 CANCELLED 로 정리됨
        assert listing.status == ResaleListingStatus.CANCELLED


@pytest.mark.asyncio
async def test_refund_cancels_matched_listing_and_buyer_order(client):
    """결함2 보완: 환불로 MATCHED listing 이 CANCELLED 될 때, 그 listing 에
    매칭된 구매자의 PAYMENT_REQUIRED RESALE_BUY 주문도 함께 CANCELLED 되고
    구매자 bid 는 ACTIVE 로 복원돼야 한다.

    수정 전엔 listing 만 CANCELLED 되고 구매자 주문이 잔존 → 구매자가 결제
    시도 시 PG 청구 성공 후 즉시 자동환불되는 청구-즉시환불 사이클(PG 수수료
    이중)이 발생했다.
    """
    from app.models.order import OrderType
    from app.models.resale import (
        ResaleBuyOrderModel,
        ResaleBuyOrderStatus,
        ResaleListingModel,
        ResaleListingStatus,
    )
    from app.services.resale_service import ResaleService

    # 판매자(원 구매자)가 티켓 구매 후 재판매 등록
    _, seller_token, _event, tier, purchase = await _setup_purchase(
        client,
        org_email="refund_matched_org@test.com",
        buyer_email="refund_matched_seller@test.com",
        quantity=1,
    )
    seller_order_id = purchase["order_id"]
    ticket_id = purchase["ticket_ids"][0]
    await confirm_purchase_payment(client, seller_token, seller_order_id)

    await _enable_resale_on_event(_event["id"])
    listing_resp = await client.post(
        "/api/v1/resale/listings",
        json={"ticket_id": ticket_id, "asking_price": 60.0},
        headers=auth_headers(seller_token),
    )
    assert listing_resp.status_code in (200, 201), listing_resp.text
    listing_id = listing_resp.json()["id"]

    # 별도 구매자가 bid 등록 → 매칭 실행 → MATCHED + 구매자 PAYMENT_REQUIRED 주문 생성
    buyer_token = await get_auth_token(client, email="refund_matched_buyer@test.com")
    buy_resp = await client.post(
        "/api/v1/resale/buy-orders",
        json={
            "event_id": _event["id"],
            "tier_id": tier["id"],
            "max_price": 65.0,
        },
        headers=auth_headers(buyer_token),
    )
    assert buy_resp.status_code in (200, 201), buy_resp.text

    async with TestSession() as session:
        service = ResaleService(session)
        trades = await service.match_and_execute(
            event_id=uuid.UUID(_event["id"]),
            tier_id=uuid.UUID(tier["id"]),
        )
        await session.commit()
    assert len(trades) == 1
    buy_order_bid_id = trades[0]["buy_order_id"]

    # 매칭 직후 상태 확인: listing=MATCHED, 구매자 주문=PAYMENT_REQUIRED 존재
    async with TestSession() as session:
        listing = (
            await session.execute(
                select(ResaleListingModel).where(
                    ResaleListingModel.id == uuid.UUID(listing_id)
                )
            )
        ).scalar_one()
        assert listing.status == ResaleListingStatus.MATCHED

        buyer_orders = (
            await session.execute(
                select(Order).where(
                    Order.order_type == OrderType.RESALE_BUY,
                    Order.status == OrderStatus.PAYMENT_REQUIRED,
                )
            )
        ).scalars().all()
        assert len(buyer_orders) == 1
        buyer_order_id = buyer_orders[0].id

    # 판매자(원 구매자) 전액 환불 → 티켓 CANCELLED → MATCHED listing 정리
    refund_resp = await client.post(
        f"/api/v1/orders/{seller_order_id}/refund",
        json={"reason": "MATCHED 재판매 등록 후 원구매 환불"},
        headers=auth_headers(seller_token),
    )
    assert refund_resp.status_code == 200, refund_resp.text

    async with TestSession() as session:
        ticket = (
            await session.execute(select(Ticket).where(Ticket.id == uuid.UUID(ticket_id)))
        ).scalar_one()
        assert ticket.status == TicketStatus.CANCELLED

        listing = (
            await session.execute(
                select(ResaleListingModel).where(
                    ResaleListingModel.id == uuid.UUID(listing_id)
                )
            )
        ).scalar_one()
        assert listing.status == ResaleListingStatus.CANCELLED

        # 핵심: 구매자 PAYMENT_REQUIRED 주문이 잔존하지 않고 CANCELLED 됨
        buyer_order = (
            await session.execute(select(Order).where(Order.id == buyer_order_id))
        ).scalar_one()
        assert buyer_order.status == OrderStatus.CANCELLED

        # 구매자 bid 는 ACTIVE 로 복원되어 다른 listing 과 재매칭 가능
        bid = (
            await session.execute(
                select(ResaleBuyOrderModel).where(
                    ResaleBuyOrderModel.id == uuid.UUID(buy_order_bid_id)
                )
            )
        ).scalar_one()
        assert bid.status == ResaleBuyOrderStatus.ACTIVE


@pytest.mark.asyncio
async def test_partial_amount_refund_keeps_other_tickets(client, allow_partial_cancel):
    """결함2(기각 근거 회귀 테스트): 부분 금액 환불은 지정 티켓만 취소하고
    나머지 티켓과 주문 자체는 유지된다.

    부분 금액 환불은 코드상 ticket_ids 명시가 강제(request_refund L340-344)되며,
    RefundItem 은 그 티켓에만 생성된다. 따라서 '부분 금액 환불이 티켓 전액
    취소' 라는 결함2 전제는 성립하지 않는다.
    """
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(
        client,
        org_email="refund_partial2_org@test.com",
        buyer_email="refund_partial2_buyer@test.com",
        quantity=2,
    )
    order_id = purchase["order_id"]
    await confirm_purchase_payment(client, buyer_token, order_id)

    refund_ticket_id = purchase["ticket_ids"][0]
    keep_ticket_id = purchase["ticket_ids"][1]

    resp = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "부분 금액 환불", "amount": 50.0, "ticket_ids": [refund_ticket_id]},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200, resp.text

    async with TestSession() as session:
        order = (
            await session.execute(select(Order).where(Order.id == uuid.UUID(order_id)))
        ).scalar_one()
        # 주문은 취소되지 않고 유지
        assert order.status == OrderStatus.CONFIRMED

        tickets = {
            str(t.id): t.status
            for t in (
                await session.execute(
                    select(Ticket).where(Ticket.purchase_order_id == uuid.UUID(order_id))
                )
            ).scalars()
        }
        assert tickets[refund_ticket_id] == TicketStatus.CANCELLED
        assert tickets[keep_ticket_id] == TicketStatus.ACTIVE
