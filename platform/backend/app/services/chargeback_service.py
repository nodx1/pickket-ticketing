"""차지백 확정 재무 반영 서비스 — 블로커 #7.

차지백이 accepted(수용) 또는 lost(분쟁 패배)로 확정되면 자금은 이미
카드사/PG 단에서 회수된 상태다. PG 환불 API 를 다시 호출하면 이중 환불이므로
PG 호출 없이 원장만 정합화한다:

① Refund 기록 생성 (status=COMPLETED, PG 호출 없음 — 자금은 차지백으로 이미 반환)
② 티켓 회수 — 미사용·구매자 보유 티켓은 CANCELLED, 체크인(USED)·양도된 티켓은
   회수 불가로 플래그(운영 알림 + 감사 기록)만 남김
③ order.total_refunded 증가 + 주문 상태 전이 → 정산 클로백
   (settlement_generate 의 환불등가액 재계산)이 다음 주기에 자동 차감

멱등: Refund.idempotency_key = "chargeback:{chargeback_id}".
"""

import logging
import uuid
from datetime import datetime, timezone
from decimal import ROUND_DOWN, Decimal

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.alerting import send_ops_alert
from app.models.chargeback import Chargeback
from app.models.order import Order, OrderStatus, OrderType, validate_order_transition
from app.models.refund import Refund, RefundItem, RefundStatus, RefundType
from app.models.resale import ResaleListingModel, ResaleListingStatus
from app.models.ticket import Ticket, TicketStatus
from app.services.refund_service import RefundService

logger = logging.getLogger(__name__)

_CENT = Decimal("0.01")


class ChargebackResolutionError(Exception):
    """차지백 확정 재무 반영 오류."""


def _dec(value) -> Decimal:
    return Decimal(str(value if value is not None else 0))


def _allocate_item_amounts(weights: list[Decimal], total: Decimal) -> list[Decimal]:
    """total 을 weights 비례로 배분하되 합계가 정확히 total 이 되도록 보장.

    - weights 합이 total 과 같으면(클램프 없음) weights 를 그대로 반환.
    - 그 외에는 비례 배분(센트 단위 내림) 후 잔차를 마지막 item 에 흡수.
    - weights 합이 0(전부 0원 티켓)이면 마지막 item 에 total 전액을 몰아준다.
    이렇게 하면 sum(반환) == total 이 항상 성립한다.
    """
    if not weights:
        return []
    total = total.quantize(_CENT)
    weight_sum = sum(weights, Decimal("0")).quantize(_CENT)
    if weight_sum == total:
        return [w.quantize(_CENT) for w in weights]
    if weight_sum == 0:
        # 비례 기준이 없음 — 마지막 item 에 전액 배정(나머지는 0).
        return [Decimal("0")] * (len(weights) - 1) + [total]
    allocated: list[Decimal] = []
    running = Decimal("0")
    for w in weights[:-1]:
        share = (total * w / weight_sum).quantize(_CENT, rounding=ROUND_DOWN)
        allocated.append(share)
        running += share
    allocated.append((total - running).quantize(_CENT))  # 잔차 흡수
    return allocated


async def apply_chargeback_resolution(
    session: AsyncSession,
    chargeback: Chargeback,
    *,
    actor_id: uuid.UUID | None = None,
) -> dict:
    """accepted/lost 확정 차지백의 환불 기록·티켓 회수·원장 반영.

    호출자(API)가 트랜잭션을 소유한다 — 여기서는 commit 하지 않는다.
    실패 시 예외를 올려 상태 전이 자체를 롤백시킨다(부분 반영 방지).
    """
    idempotency_key = f"chargeback:{chargeback.id}"

    # 0. 멱등 — 이미 반영된 차지백이면 재적용하지 않음
    existing = (
        await session.execute(select(Refund).where(Refund.idempotency_key == idempotency_key))
    ).scalar_one_or_none()
    if existing:
        logger.info("chargeback 재무 반영 skip (이미 처리됨): chargeback=%s", chargeback.id)
        return {"refund_id": str(existing.id), "already_applied": True}

    # 1. 주문 잠금
    order = (
        await session.execute(
            select(Order).where(Order.id == chargeback.order_id).with_for_update()
        )
    ).scalar_one_or_none()
    if not order:
        raise ChargebackResolutionError(f"Order {chargeback.order_id} not found")

    now = datetime.now(timezone.utc)
    cb_amount = _dec(chargeback.amount).quantize(_CENT)
    remaining = (_dec(order.total_amount) - _dec(order.total_refunded)).quantize(_CENT)
    # 원장 차감액 — ck_orders_total_refunded_lte_total 위반 방지를 위해 잔액으로 클램프.
    # PG 측 실회수액(cb_amount)과 다르면 운영 확인 필요(아래 경고).
    ledger_amount = min(cb_amount, remaining)
    if ledger_amount < cb_amount:
        logger.warning(
            "chargeback 금액(%s)이 환불 가능 잔액(%s) 초과 — 잔액만 원장 반영: chargeback=%s order=%s",
            cb_amount, remaining, chargeback.id, order.id,
        )

    # 2. 티켓 회수 — RESALE_BUY 주문은 메타의 ticket_id, 그 외는 purchase_order 연결
    if order.order_type == OrderType.RESALE_BUY:
        tickets = await _get_resale_tickets(session, order)
    else:
        result = await session.execute(
            select(Ticket).where(Ticket.purchase_order_id == order.id).with_for_update()
        )
        tickets = list(result.scalars().all())

    revoked: list[Ticket] = []
    revoked_before: dict[uuid.UUID, str] = {}
    unrevocable: list[dict] = []
    for ticket in tickets:
        before = ticket.status.value if hasattr(ticket.status, "value") else str(ticket.status)
        if ticket.status == TicketStatus.CANCELLED:
            continue  # 이미 환불 등으로 회수됨
        if ticket.status == TicketStatus.USED or ticket.checked_in_at is not None:
            # 이미 입장 — 회수 불가. 플래그만 남기고 운영 수동 처리.
            unrevocable.append({"ticket_id": str(ticket.id), "reason": "checked_in"})
            continue
        if ticket.current_owner_id != order.user_id:
            # 양도/재판매로 제3자 소유 — 선의의 현 소유자 티켓을 자동 취소하지 않음.
            unrevocable.append({"ticket_id": str(ticket.id), "reason": "transferred"})
            continue
        ticket.status = TicketStatus.CANCELLED
        revoked.append(ticket)
        revoked_before[ticket.id] = before
        logger.info(
            "chargeback 티켓 회수: ticket=%s (%s→cancelled) chargeback=%s",
            ticket.id, before, chargeback.id,
        )

    # 회수 티켓의 활성 재판매 리스팅 무효화 (회수 후 재판매 이중수익 차단)
    if revoked:
        await session.execute(
            update(ResaleListingModel)
            .where(
                ResaleListingModel.ticket_id.in_([t.id for t in revoked]),
                ResaleListingModel.status == ResaleListingStatus.ACTIVE,
            )
            .values(status=ResaleListingStatus.CANCELLED)
        )

    # 3. Refund 기록 (PG 호출 없음 — 자금은 차지백으로 이미 회수됨)
    refund = None
    if ledger_amount > 0:
        is_full = (_dec(order.total_refunded) + ledger_amount) >= _dec(order.total_amount) - _CENT
        refund = Refund(
            order_id=order.id,
            idempotency_key=idempotency_key,
            refund_type=RefundType.FULL if is_full else RefundType.PARTIAL,
            status=RefundStatus.COMPLETED,
            amount=ledger_amount,
            currency=chargeback.currency or order.payment_currency,
            reason=f"차지백 확정({chargeback.status}): {chargeback.reason}"[:300],
            initiated_by="system",
            initiated_by_user_id=actor_id,
            requires_approval=False,
            pg_refund_id=chargeback.pg_chargeback_id,
            pg_response={
                "chargeback_id": str(chargeback.id),
                "note": "funds reversed by card network chargeback — no PG refund call",
            },
            processed_at=now,
        )
        # RefundItem.amount 합계는 Refund.amount(=ledger_amount, 클램프 반영)와
        # 일치해야 한다(감사/대사 정합). 클램프가 없으면 티켓 구매가 전액을 그대로
        # 기록하고, 클램프가 발생하면 ledger_amount를 티켓 구매가 비례로 배분하되
        # 반올림 잔차는 마지막 item에 흡수해 합계 == ledger_amount를 보장한다.
        item_amounts = _allocate_item_amounts(
            [_dec(t.purchase_price).quantize(_CENT) for t in revoked],
            ledger_amount,
        )
        for ticket, item_amount in zip(revoked, item_amounts):
            refund.items.append(
                RefundItem(
                    ticket_id=ticket.id,
                    seat_id=ticket.seat_id,
                    amount=item_amount,
                    ticket_status_before=revoked_before.get(ticket.id, "active"),
                    ticket_status_after="cancelled",
                )
            )
        session.add(refund)

        # 4. 원장 반영 — 원자적 증가 (refund_service 와 동일 패턴)
        await session.execute(
            update(Order)
            .where(Order.id == order.id)
            .values(total_refunded=Order.total_refunded + ledger_amount)
        )
        await session.refresh(order, ["total_refunded"])

        # 5. 주문 상태 전이
        target = OrderStatus.REFUNDED if is_full else OrderStatus.PARTIALLY_REFUNDED
        if order.status != target:
            try:
                validate_order_transition(order.status, target)
                order.status = target
            except ValueError:
                # 이미 터미널 상태(cancelled 등) — 원장만 반영하고 상태는 유지
                logger.warning(
                    "chargeback 주문 상태 전이 불가(%s→%s) — 원장만 반영: order=%s",
                    order.status.value, target.value, order.id,
                )

    # 6. 재고/좌석 원복 (회수 티켓 한정) — refund_service 로직 재사용
    if revoked:
        refund_svc = RefundService(session)
        await refund_svc._decrement_sold_counts(revoked)
        await refund_svc._release_seats(revoked)

    await session.flush()

    # 7. 체크인/양도 티켓은 운영 수동 처리 알림 (best-effort)
    if unrevocable:
        try:
            await send_ops_alert("warning", "차지백 티켓 회수 불가 — 수동 확인 필요", {
                "chargeback_id": str(chargeback.id),
                "order_id": str(order.id),
                "amount": float(cb_amount),
                "tickets": ", ".join(f"{t['ticket_id'][:8]}({t['reason']})" for t in unrevocable),
            })
        except Exception:
            logger.warning("chargeback 회수불가 ops alert 실패", exc_info=True)

    return {
        "refund_id": str(refund.id) if refund else None,
        "ledger_amount": float(ledger_amount),
        "chargeback_amount": float(cb_amount),
        "order_status": order.status.value if hasattr(order.status, "value") else str(order.status),
        "tickets_revoked": [str(t.id) for t in revoked],
        "tickets_unrevocable": unrevocable,
        "already_applied": False,
    }


async def _get_resale_tickets(session: AsyncSession, order: Order) -> list[Ticket]:
    """RESALE_BUY 주문의 대상 티켓 — payment_metadata.resale.ticket_id 기준."""
    meta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
    resale = meta.get("resale") if isinstance(meta.get("resale"), dict) else {}
    ticket_id_str = resale.get("ticket_id") if resale else None
    if not ticket_id_str:
        logger.warning("RESALE_BUY 주문에 resale.ticket_id 없음 — 티켓 회수 생략: order=%s", order.id)
        return []
    try:
        ticket_id = uuid.UUID(str(ticket_id_str))
    except ValueError:
        logger.warning("resale.ticket_id 파싱 실패 — 티켓 회수 생략: order=%s", order.id)
        return []
    result = await session.execute(
        select(Ticket).where(Ticket.id == ticket_id).with_for_update()
    )
    ticket = result.scalar_one_or_none()
    return [ticket] if ticket else []
