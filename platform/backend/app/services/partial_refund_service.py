"""부분 환불 서비스 — P2-11 Partial Refund + Chargeback.

기존 RefundService를 확장하여 아이템 단위 환불과 수량 기반 환불을 지원합니다.
PortOne 부분 환불 API를 호출하여 실제 PG 부분 환불을 처리합니다.
"""

import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.audit import write_audit_log
from app.core.alerting import send_ops_alert
from app.models.order import Order, OrderStatus
from app.models.ownership_transfer import OwnershipTransfer
from app.models.ticket import Ticket, TicketStatus
from app.models.refund import Refund, RefundItem, RefundStatus, RefundType
from app.repositories.event_repo import SeatTierRepository
from app.services.nicepay_gateway import PartialCancelUnsupportedError
from app.services.payment_gateway import (
    build_void_kwargs,
    get_payment_gateway,
    resolve_cancel_amount,
)
from app.services.refund_service import (
    COMMITTED_REFUND_STATUSES,
    RefundError,
    apply_refund_policy,
    get_active_refund_ticket_ids,
    get_reserved_refund_total,
)

logger = logging.getLogger(__name__)


class PartialRefundError(Exception):
    """부분 환불 처리 오류."""


class PartialRefundService:
    """아이템/수량 기반 부분 환불 처리."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.gateway = get_payment_gateway()
        self.tier_repo = SeatTierRepository(session)
        # Drained by API layer after db.commit() — PR-U2 v2→go propagation.
        self.propagations: list[dict] = []

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)

    def _gateway_for(self, order):
        provider = getattr(order, "pg_provider", None)
        if not provider or provider.strip().lower() == self.gateway.provider_name:
            return self.gateway
        return get_payment_gateway(provider)

    async def _get_order_for_update(self, order_id: uuid.UUID) -> Order:
        stmt = (
            select(Order)
            .where(Order.id == order_id)
            .with_for_update()
            .options(selectinload(Order.event))
        )
        result = await self.session.execute(stmt)
        order = result.scalar_one_or_none()
        if not order:
            raise PartialRefundError(f"Order {order_id} not found")
        return order

    async def _get_active_tickets(
        self,
        order_id: uuid.UUID,
        *,
        lock: bool = False,
    ) -> list[Ticket]:
        stmt = select(Ticket).where(
            Ticket.purchase_order_id == order_id,
            Ticket.status.in_([TicketStatus.ACTIVE, TicketStatus.PENDING]),
        )
        if lock:
            stmt = stmt.with_for_update()
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def _ensure_refund_ticket_ownership(
        self,
        *,
        order: Order,
        tickets: list[Ticket],
    ) -> None:
        ticket_ids = [ticket.id for ticket in tickets]
        if not ticket_ids:
            return

        transferred_tickets = [
            ticket.id for ticket in tickets if ticket.current_owner_id != order.user_id
        ]
        if transferred_tickets:
            raise PartialRefundError(
                "환불 차단: 양도 완료된 티켓은 원주문 기준으로 환불할 수 없습니다"
            )

        result = await self.session.execute(
            select(OwnershipTransfer.ticket_id).where(
                OwnershipTransfer.ticket_id.in_(ticket_ids),
                OwnershipTransfer.status.not_in(["completed", "cancelled"]),
            )
        )
        in_flight_ticket_ids = result.scalars().all()
        if in_flight_ticket_ids:
            raise PartialRefundError("환불 차단: 양도 진행 중인 티켓이 포함되어 있습니다")

    async def process_partial_refund(
        self,
        order_id: uuid.UUID,
        items: list[dict],
        *,
        reason: str = "부분 환불 요청",
        initiated_by: str = "admin",
        initiated_by_user_id: uuid.UUID | None = None,
        idempotency_key: str | None = None,
        force_auto_approve: bool = False,
    ) -> Refund:
        """아이템 단위 부분 환불.

        일반 환불(RefundService.request_refund)과 동일한 정책 게이트를 탄다:
        취소 수수료(이벤트 당일 100% = 환불 금지 포함) + 금액별 admin 승인.
        승인 필요 금액이면 PENDING 으로 생성만 하고 PG 호출은 하지 않는다
        (admin 승인은 RefundService.approve_refund 경로).

        Args:
            order_id: 주문 ID
            items: [{"ticket_id": UUID, "amount": float}, ...]
            reason: 환불 사유
            initiated_by: "user" / "admin" / "system"
            initiated_by_user_id: 요청자 사용자 ID
            idempotency_key: 멱등성 키
            force_auto_approve: 내부(system/admin bulk) 경로 전용 — 승인 생략

        Returns:
            생성된 Refund 객체
        """
        # Idempotency
        if idempotency_key:
            existing = await self.session.execute(
                select(Refund)
                .where(Refund.idempotency_key == idempotency_key)
                .options(selectinload(Refund.items))
            )
            found = existing.scalar_one_or_none()
            if found:
                return found

        if not items:
            raise PartialRefundError("환불할 아이템을 지정해주세요")

        order = await self._get_order_for_update(order_id)
        if order.status not in (OrderStatus.CONFIRMED, OrderStatus.PAID):
            raise PartialRefundError(f"환불 불가 주문 상태: {order.status.value}")

        active_tickets = await self._get_active_tickets(order_id, lock=True)
        active_ticket_map = {t.id: t for t in active_tickets}

        # 아이템 검증
        refund_items = []
        total_refund_amount = 0.0

        for item in items:
            ticket_id = uuid.UUID(str(item["ticket_id"])) if not isinstance(item["ticket_id"], uuid.UUID) else item["ticket_id"]

            ticket = active_ticket_map.get(ticket_id)
            if not ticket:
                raise PartialRefundError(
                    f"Ticket {ticket_id} not found or not refundable in this order"
                )
            raw_amount = item.get("amount")
            amount = float(ticket.purchase_price if raw_amount is None else raw_amount)
            if amount <= 0:
                raise PartialRefundError(f"환불 금액은 0보다 커야 합니다: ticket {ticket_id}")
            if amount > float(ticket.purchase_price):
                raise PartialRefundError(
                    f"환불 금액({amount})이 티켓 가격({float(ticket.purchase_price)})을 초과합니다"
                )

            refund_items.append((ticket, amount))
            total_refund_amount += amount

        await self._ensure_refund_ticket_ownership(
            order=order,
            tickets=[ticket for ticket, _amount in refund_items],
        )

        # 동일 티켓의 진행 중 환불(PENDING/APPROVED/PROCESSING) 차단 (M-3)
        in_flight = await get_active_refund_ticket_ids(
            self.session, [ticket.id for ticket, _amount in refund_items]
        )
        if in_flight:
            raise PartialRefundError(
                "환불 차단: 이미 진행 중인 환불 요청에 포함된 티켓입니다"
            )

        # 누적 환불 상한 검증 — COMPLETED(total_refunded) 외에 진행 중
        # 환불 예약분(PENDING/APPROVED/PROCESSING)까지 차감 (M-3)
        reserved = float(await get_reserved_refund_total(self.session, order_id))
        max_refundable = float(order.total_amount) - float(order.total_refunded) - reserved
        if total_refund_amount > max_refundable + 0.01:
            raise PartialRefundError(
                f"환불 가능 금액({max_refundable:.2f}) 초과: 요청 {total_refund_amount:.2f}"
            )

        # ── 공통 정책 게이트 (M-3): 일반 환불 경로와 동일하게
        # 취소 수수료(당일 100% = 환불 금지) + 자동 승인 한도를 적용 ──
        try:
            policy = apply_refund_policy(
                event=getattr(order, "event", None),
                gross_amount=Decimal(str(total_refund_amount)),
                force_auto_approve=force_auto_approve,
            )
        except RefundError as e:
            raise PartialRefundError(str(e)) from e
        if policy.fee_pct > 0:
            logger.info(
                "부분 환불 취소 수수료 적용: order=%s fee_pct=%.1f%% fee=%s refund=%s",
                order_id, policy.fee_pct, policy.cancellation_fee, policy.refund_amount,
            )

        # Refund 레코드 생성 (수수료 차감 후 금액, 한도 초과 시 PENDING).
        # FULL/PARTIAL은 지급액이 아니라 취소 티켓 범위로 판정한다.
        cancels_all_tickets = {ticket.id for ticket, _amount in refund_items} == {
            ticket.id for ticket in active_tickets
        }
        refund = Refund(
            order_id=order_id,
            idempotency_key=idempotency_key,
            refund_type=RefundType.FULL if cancels_all_tickets else RefundType.PARTIAL,
            amount=policy.refund_amount,
            currency=order.payment_currency,
            reason=reason[:300],
            initiated_by=initiated_by,
            initiated_by_user_id=initiated_by_user_id,
            requires_approval=policy.requires_approval,
            status=RefundStatus.PENDING if policy.requires_approval else RefundStatus.APPROVED,
        )
        self.session.add(refund)

        for ticket, amount in refund_items:
            refund.items.append(
                RefundItem(
                    ticket_id=ticket.id,
                    seat_id=ticket.seat_id,
                    amount=amount,
                    ticket_status_before=ticket.status.value if hasattr(ticket.status, "value") else str(ticket.status),
                    ticket_status_after="cancelled",
                )
            )

        await self.session.flush()

        # 자동 승인이면 즉시 PG 부분 환불 실행.
        # 승인 필요(PENDING)면 PG 호출 없이 대기 — admin 승인 시
        # RefundService.approve_refund 가 재검증 후 처리한다.
        if not policy.requires_approval:
            await self._process_pg_partial_refund(refund, order, [t for t, _ in refund_items])

        # 감사 로그
        await write_audit_log(
            self.session,
            actor_id=initiated_by_user_id,
            action="refund.partial_item" if not policy.requires_approval else "refund.partial_item_requested",
            resource_type="refund",
            resource_id=str(refund.id),
            event_id=order.event_id,
            new_value={
                "amount": float(policy.refund_amount),
                "gross_amount": float(policy.gross_amount),
                "fee_pct": policy.fee_pct,
                "requires_approval": policy.requires_approval,
                "reason": reason[:200],
                "item_count": len(items),
                "order_id": str(order_id),
            },
        )

        # 승인 필요 시 운영 알림 (일반 환불 경로와 동일)
        if policy.requires_approval:
            try:
                await send_ops_alert("warning", "환불 승인 요청 (부분 환불)", {
                    "주문": str(order_id)[:8],
                    "금액": f"{float(policy.refund_amount):,.0f}원",
                    "사유": reason[:100],
                })
            except Exception:
                logger.warning("ops partial refund alert failed", exc_info=True)

        return refund

    async def process_quantity_refund(
        self,
        order_id: uuid.UUID,
        quantity: int,
        *,
        reason: str = "수량 기반 환불",
        initiated_by: str = "admin",
        initiated_by_user_id: uuid.UUID | None = None,
        idempotency_key: str | None = None,
        force_auto_approve: bool = False,
    ) -> Refund:
        """수량 기반 부분 환불 — N개 티켓을 환불.

        가격이 가장 높은 티켓부터 환불 처리합니다.
        process_partial_refund 로 위임하므로 동일한 정책 게이트
        (취소 수수료 + 승인 한도)를 적용받습니다.

        Args:
            order_id: 주문 ID
            quantity: 환불할 티켓 수
            reason: 환불 사유

        Returns:
            생성된 Refund 객체
        """
        if quantity <= 0:
            raise PartialRefundError("환불 수량은 1 이상이어야 합니다")

        active_tickets = await self._get_active_tickets(order_id)
        if not active_tickets:
            raise PartialRefundError("환불 가능한 티켓이 없습니다")
        if quantity > len(active_tickets):
            raise PartialRefundError(
                f"환불 수량({quantity})이 활성 티켓 수({len(active_tickets)})를 초과합니다"
            )

        # 가격 높은 순으로 정렬하여 선택
        sorted_tickets = sorted(
            active_tickets, key=lambda t: float(t.purchase_price), reverse=True
        )
        selected = sorted_tickets[:quantity]

        items = [
            {"ticket_id": t.id, "amount": float(t.purchase_price)}
            for t in selected
        ]

        return await self.process_partial_refund(
            order_id,
            items,
            reason=reason,
            initiated_by=initiated_by,
            initiated_by_user_id=initiated_by_user_id,
            idempotency_key=idempotency_key,
            force_auto_approve=force_auto_approve,
        )

    async def _process_pg_partial_refund(
        self,
        refund: Refund,
        order: Order,
        target_tickets: list[Ticket],
    ) -> None:
        """PortOne 부분 환불 API 호출."""
        refund.status = RefundStatus.PROCESSING

        # ── M-3 과환불 방어: PG 호출 전에 상한 검증 ──
        # remaining(PG측 취소 가능 잔액)에서 자신을 제외한 지급 확정
        # (APPROVED/PROCESSING) 환불 예약분까지 차감한다.
        refund_amount = Decimal(str(refund.amount))
        remaining = Decimal(str(order.total_amount)) - Decimal(str(order.total_refunded))
        reserved_others = await get_reserved_refund_total(
            self.session,
            order.id,
            exclude_refund_id=refund.id,
            statuses=COMMITTED_REFUND_STATUSES,
        )
        available = remaining - reserved_others
        if refund_amount > available + Decimal("0.01"):
            refund.status = RefundStatus.FAILED
            refund.pg_response = {
                "error": "over-refund rejected before PG call",
                "refund_amount": float(refund_amount),
                "max_refundable": float(available),
            }
            raise PartialRefundError(
                f"환불 가능 금액({available:.2f}) 초과: 요청 {refund_amount:.2f}"
            )

        # M-3: 부분 환불액을 PG에 명시 전달 — amount 미전달 시 PortOne은
        # 잔액 전체를 취소하므로 원장(부분 환불 기록)과 실제 카드 취소가 어긋난다.
        # 잔액 전체와 같은 금액이면 None(전액 취소)으로 호출.
        is_full_cancel = refund_amount >= remaining - Decimal("0.01")
        cancel_amount = resolve_cancel_amount(order, refund_amount, is_full=is_full_cancel)

        try:
            if order.payment_id:
                gateway = self._gateway_for(order)
                kwargs = build_void_kwargs(
                    gateway,
                    order,
                    payment_id=order.payment_id,
                    reason=f"부분환불: {refund.reason}",
                    amount=cancel_amount,
                )
                pg_result = await gateway.void_authorization(
                    **kwargs,
                )
                # 🔴 PG 거절은 예외가 아니라 voided=False 로 온다 — 검사하지 않으면
                #    "돈은 안 나갔는데 원장은 환불완료" 가 조용히 생긴다(refund_service 와 동일).
                if not getattr(pg_result, "voided", False):
                    raise RefundError(
                        "PG 부분취소가 거절되었습니다(voided=False). 환불을 확정하지 않습니다: "
                        f"{getattr(pg_result, 'raw', {})}"
                    )
                refund.pg_refund_id = getattr(pg_result, "transaction_id", None)
                refund.pg_response = getattr(pg_result, "raw", {})
            else:
                refund.pg_response = {"mock": True, "note": "No payment_id — partial refund"}

            refund.status = RefundStatus.COMPLETED
            refund.processed_at = self._now()

            # 티켓 상태 변경
            for ticket in target_tickets:
                ticket.status = TicketStatus.CANCELLED

            # 재고 복원
            await self._decrement_sold_counts(target_tickets)
            await self._release_seats(target_tickets)

            # Order 업데이트 (SQL 원자적 — 동시 환불 race condition 방지)
            from app.models.order import Order as OrderModel
            await self.session.execute(
                sa_update(OrderModel)
                .where(OrderModel.id == order.id)
                .values(total_refunded=OrderModel.total_refunded + Decimal(str(refund.amount)))
            )
            await self.session.refresh(order, ["total_refunded"])
            # 수수료로 지급액이 줄어도 마지막 활성 티켓을 취소하면 주문 계약은 종료된다.
            is_full_refund = refund.refund_type == RefundType.FULL
            if is_full_refund:
                order.status = OrderStatus.REFUNDED
            else:
                order.status = OrderStatus.PARTIALLY_REFUNDED

            # PR-U2: v2 → go propagation (order.refunded, partial)
            self.propagations.append({
                "event": "order.refunded",
                "order_id": str(order.id),  # 🔴 UUID 그대로면 워커가 json.dumps 에서 죽는다
                "data": {
                    "refund_id": str(refund.id),
                    "refund_amount": float(refund.amount),
                    "total_refunded": float(order.total_refunded),
                    "original_amount": float(order.total_amount),
                    "is_full_refund": is_full_refund,
                    "is_partial": not is_full_refund,
                    "ticket_count": len(target_tickets),
                    "reason": (refund.reason or "")[:200],
                    "pg_refund_id": refund.pg_refund_id,
                    "refunded_at": refund.processed_at.isoformat() if refund.processed_at else None,
                    "source_product": "consumer",
                },
            })

            # 알림
            try:
                from app.models.notification import NotificationModel
                notification = NotificationModel(
                    user_id=order.user_id,
                    type="partial_refund_complete",
                    message=f"부분 환불이 완료되었습니다. ({float(refund.amount):,.0f}원)",
                    data={
                        "refund_id": str(refund.id),
                        "order_id": str(order.id),
                        "amount": float(refund.amount),
                        "ticket_count": len(target_tickets),
                    },
                )
                self.session.add(notification)
            except Exception:
                logger.warning("부분 환불 알림 발송 실패: refund=%s", refund.id)

        except PartialCancelUnsupportedError as e:
            # 🔴 부분취소 가드 — 전문을 보내기 전에 끊은 것이라 **돈은 움직이지 않았다**.
            #    PG 장애가 아니므로 critical 운영알럿(mention=True)을 울리지 않는다.
            #    울리면 진짜 사고가 그 소음에 묻힌다(refund_service 와 동일 처리).
            refund.status = RefundStatus.FAILED
            refund.pg_response = {"error": str(e), "guard": "partial_cancel_blocked"}
            logger.info("부분취소 차단: order=%s refund=%s", order.id, refund.id)
            raise PartialRefundError(str(e)) from e
        except Exception as e:
            refund.status = RefundStatus.FAILED
            refund.pg_response = {"error": str(e)}

            try:
                await send_ops_alert("critical", "PG 부분 환불 실패", {
                    "refund_id": str(refund.id),
                    "order_id": str(order.id),
                    "amount": float(refund.amount),
                    "error": str(e),
                }, mention=True)
            except Exception:
                pass

            raise PartialRefundError(f"PG partial refund failed: {e}") from e

    async def _decrement_sold_counts(self, tickets: list[Ticket]) -> None:
        import os

        # sold_count: PG 는 trg_sync_sold_count 가 ticket→cancelled 시 자동 -1.
        # 명시 decrement_sold 동시 호출 시 이중감소 → SQLite(test) 에서만 수동 감소.
        if not os.environ.get("PYTEST_CURRENT_TEST"):
            return
        quantity_by_tier: dict[uuid.UUID, int] = {}
        for ticket in tickets:
            quantity_by_tier[ticket.tier_id] = quantity_by_tier.get(ticket.tier_id, 0) + 1
        for tier_id, qty in quantity_by_tier.items():
            await self.tier_repo.decrement_sold(tier_id, qty)

    async def _release_seats(self, tickets: list[Ticket]) -> None:
        seat_ids = [t.seat_id for t in tickets if t.seat_id]
        if not seat_ids:
            return
        try:
            from app.repositories.seat_repo import SeatRepository
            seat_repo = SeatRepository(self.session)
            await seat_repo.release_sold(seat_ids)
        except Exception:
            logger.warning("좌석 해제 실패: seats=%s", seat_ids)
