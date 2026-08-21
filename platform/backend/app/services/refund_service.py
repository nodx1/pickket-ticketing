"""환불 서비스 — 승인 워크플로우 + idempotency + 감사 로그.

기존 payment_service.initiate_refund()의 로직을 이관 + 강화.
"""

import logging
import math
import uuid
from dataclasses import dataclass
from datetime import datetime, time, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.audit import write_audit_log
from app.core.alerting import send_ops_alert
from app.core.config import settings
from app.models.event import Event
from app.models.order import Order, OrderStatus, OrderType
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

logger = logging.getLogger(__name__)

# 자동 승인 한도 (이하 금액은 admin 승인 없이 즉시 환불)
REFUND_AUTO_APPROVE_LIMIT = 50_000

# 기본 취소 수수료 단계 (이벤트별 커스텀 미설정 시 적용)
DEFAULT_CANCELLATION_TIERS = [
    {"days_before": 10, "fee_pct": 0},
    {"days_before": 7, "fee_pct": 10},
    {"days_before": 3, "fee_pct": 20},
    {"days_before": 1, "fee_pct": 30},
    {"days_before": 0, "fee_pct": 100},
]

KST = ZoneInfo("Asia/Seoul")


class RefundError(Exception):
    """환불 처리 오류."""


# 환불 가능액 계산 시 "예약된 것"으로 취급할 진행 중 상태.
# COMPLETED 는 order.total_refunded 에 이미 반영되고,
# FAILED / REJECTED 는 소멸된 요청이므로 제외한다.
ACTIVE_REFUND_STATUSES = (
    RefundStatus.PENDING,
    RefundStatus.APPROVED,
    RefundStatus.PROCESSING,
)

# 실제로 지급이 확정/진행된 상태 — 승인 시점·PG 호출 직전 재검증에 사용.
# PENDING 은 아직 승인되지 않은 "요청"일 뿐이고 각자의 승인 시점에
# 재검증되므로, 여기 포함하면 정당한 단일 승인까지 막아 버린다.
COMMITTED_REFUND_STATUSES = (
    RefundStatus.APPROVED,
    RefundStatus.PROCESSING,
)


async def get_reserved_refund_total(
    session: AsyncSession,
    order_id: uuid.UUID,
    *,
    exclude_refund_id: uuid.UUID | None = None,
    statuses: tuple[RefundStatus, ...] = ACTIVE_REFUND_STATUSES,
) -> Decimal:
    """주문에 걸려 있는 진행 중 환불 예약 총액.

    이중 환불 방어(M-3): 환불 가능액은
    ``total_amount − total_refunded − reserved`` 로 계산해야 한다.
    - 요청 시점: PENDING 포함(ACTIVE_REFUND_STATUSES) — 미승인 요청을
      빼지 않으면 같은 주문으로 환불 요청을 여러 건 쌓아 모두 승인받는
      이중 환불이 가능해진다.
    - 승인/PG 직전 재검증 시점: COMMITTED_REFUND_STATUSES — 다른 PENDING
      요청은 각자의 승인 시점에 재검증되므로 여기서는 제외한다.
    """
    stmt = select(func.coalesce(func.sum(Refund.amount), 0)).where(
        Refund.order_id == order_id,
        Refund.status.in_(statuses),
    )
    if exclude_refund_id is not None:
        stmt = stmt.where(Refund.id != exclude_refund_id)
    result = await session.execute(stmt)
    return Decimal(str(result.scalar() or 0))


async def get_active_refund_ticket_ids(
    session: AsyncSession,
    ticket_ids: list[uuid.UUID],
) -> list[uuid.UUID]:
    """진행 중(PENDING/APPROVED/PROCESSING) 환불에 이미 포함된 티켓 ID 목록.

    PENDING 환불은 티켓 상태를 바꾸지 않으므로, 티켓 status 검사만으로는
    같은 티켓에 대한 두 번째 환불 요청을 막을 수 없다.
    """
    if not ticket_ids:
        return []
    result = await session.execute(
        select(RefundItem.ticket_id)
        .join(Refund, Refund.id == RefundItem.refund_id)
        .where(
            RefundItem.ticket_id.in_(ticket_ids),
            Refund.status.in_(ACTIVE_REFUND_STATUSES),
        )
    )
    return list(result.scalars().all())


@dataclass(frozen=True)
class RefundPolicyDecision:
    """공통 환불 정책 게이트의 결정 결과."""

    gross_amount: Decimal       # 정책 적용 전 요청 금액
    refund_amount: Decimal      # 취소 수수료 차감 후 실제 환불액
    cancellation_fee: Decimal   # 차감된 취소 수수료
    fee_pct: float              # 적용된 수수료율 (%)
    requires_approval: bool     # 자동 승인 한도 초과 → admin 승인 필요


def apply_refund_policy(
    *,
    event: "Event | None",
    gross_amount: Decimal,
    force_auto_approve: bool = False,
) -> RefundPolicyDecision:
    """공통 환불 정책 게이트 — 취소 수수료 + 금액별 승인 요구.

    일반 환불(``RefundService.request_refund``)과 부분/수량 환불
    (``PartialRefundService``)은 **반드시** 이 함수를 거쳐야 한다.
    어느 한 경로라도 우회하면 이벤트 당일 100% 수수료(환불 금지)와
    REFUND_AUTO_APPROVE_LIMIT 승인 워크플로우가 무력화된다.

    Raises:
        RefundError: 수수료율이 100% 이상(환불 불가)인 경우.
    """
    fee_pct = 0.0
    cancellation_fee = Decimal("0")
    refund_amount = gross_amount

    if event is not None and getattr(event, "event_date", None):
        fee_pct = RefundService.calculate_cancellation_fee_pct(
            event_date=event.event_date,
            cancellation_fee_tiers=getattr(event, "cancellation_fee_tiers", None),
        )
        if fee_pct >= 100:
            raise RefundError(
                "환불 불가: 이벤트 당일 또는 이후에는 취소 수수료가 100%입니다"
            )
        if fee_pct > 0:
            cancellation_fee = round(gross_amount * Decimal(str(fee_pct)) / 100, 2)
            refund_amount = round(gross_amount - cancellation_fee, 2)

    requires_approval = (
        refund_amount > REFUND_AUTO_APPROVE_LIMIT
    ) and not force_auto_approve

    return RefundPolicyDecision(
        gross_amount=gross_amount,
        refund_amount=refund_amount,
        cancellation_fee=cancellation_fee,
        fee_pct=fee_pct,
        requires_approval=requires_approval,
    )


class RefundService:
    """환불 전체 라이프사이클 관리."""

    def __init__(self, session: AsyncSession):
        self.session = session
        # 기본 게이트웨이(전역 provider). 실제 환불은 주문별 pg_provider 로 라우팅한다(G6)
        # → _gateway_for(order). 하위호환: self.gateway 참조는 기본값 유지.
        self.gateway = get_payment_gateway()
        self.tier_repo = SeatTierRepository(session)
        # Drained by API layer after db.commit() — see orders.py refund endpoints.
        # PR-U2 (PortOne SSOT): v2 → go propagation of order.refunded.
        self.propagations: list[dict] = []

    def _gateway_for(self, order):
        """주문의 pg_provider 로 게이트웨이를 라우팅한다(G6).

        기존 toss 주문은 toss 취소, nicepay 주문은 nicepay 취소를 쓴다.
        pg_provider 미설정(레거시)이거나 기본 게이트웨이와 provider 가 같으면
        주입된 self.gateway 를 재사용(테스트 주입 존중 + 새 인스턴스 회피).
        """
        provider = getattr(order, "pg_provider", None)
        if not provider or provider.strip().lower() == self.gateway.provider_name:
            return self.gateway
        return get_payment_gateway(provider)

    async def _void_order_payment(
        self, order, *, payment_id: str, reason: str, amount: int | None = None
    ):
        gateway = self._gateway_for(order)
        # 인자 구성은 build_void_kwargs 단일 규칙 — 경로마다 복붙하다 한 곳이 누락돼
        # 실키에서 환불이 마비됐던 이력이 있다(해당 함수 주석 참조).
        kwargs = build_void_kwargs(
            gateway, order, payment_id=payment_id, reason=reason, amount=amount
        )
        return await gateway.void_authorization(**kwargs)

    @staticmethod
    def calculate_cancellation_fee_pct(
        event_date: datetime,
        cancellation_fee_tiers: list[dict] | None,
        now: datetime | None = None,
    ) -> float:
        """Return the fee using whole days until the event date's 00:00 KST boundary."""
        if now is None:
            now = datetime.now(timezone.utc)
        # Ensure both datetimes are tz-aware for subtraction
        if event_date.tzinfo is None:
            event_date = event_date.replace(tzinfo=timezone.utc)
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        tiers = cancellation_fee_tiers or DEFAULT_CANCELLATION_TIERS
        # 대표 규정은 "행사 당일 00시부터 환불 불가"다. 시작시각에서 timedelta.days를
        # 내리면 전날 오후부터 D-0이 되어 하루 일찍 수수료가 붙는다. 행사 현지 날짜의
        # 자정을 UTC로 환산하고 ceil해야 자정 1분 전은 D-1, 자정부터 D-0이 된다.
        event_day_start_kst = datetime.combine(
            event_date.astimezone(KST).date(),
            time.min,
            tzinfo=KST,
        )
        seconds_left = (
            event_day_start_kst.astimezone(timezone.utc) - now.astimezone(timezone.utc)
        ).total_seconds()
        days_left = math.ceil(seconds_left / 86_400)
        # Sort tiers by days_before ascending so the tightest matching tier wins.
        # e.g. 5 days left matches days_before=10 (0%) AND days_before=7 (10%);
        # the correct answer is 10% (the smallest days_before >= days_left).
        sorted_tiers = sorted(tiers, key=lambda t: t["days_before"])
        for tier in sorted_tiers:
            if days_left <= tier["days_before"]:
                return tier["fee_pct"]
        # More days than any tier -> no fee
        return 0

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)

    async def _get_order_for_update(
        self, order_id: uuid.UUID, *, load_event: bool = False,
    ) -> Order:
        stmt = select(Order).where(Order.id == order_id).with_for_update()
        if load_event:
            stmt = stmt.options(selectinload(Order.event))
        result = await self.session.execute(stmt)
        order = result.scalar_one_or_none()
        if not order:
            raise RefundError(f"Order {order_id} not found")
        return order

    async def _get_order_tickets(
        self, order_id: uuid.UUID, *, lock: bool = False,
    ) -> list[Ticket]:
        stmt = select(Ticket).where(Ticket.purchase_order_id == order_id)
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
            raise RefundError(
                "Refund blocked: transferred tickets are no longer owned by the order purchaser"
            )

        result = await self.session.execute(
            select(OwnershipTransfer.ticket_id).where(
                OwnershipTransfer.ticket_id.in_(ticket_ids),
                OwnershipTransfer.status.not_in(["completed", "cancelled"]),
            )
        )
        in_flight_ticket_ids = result.scalars().all()
        if in_flight_ticket_ids:
            raise RefundError("Refund blocked: ticket transfer is in progress")

    async def _find_by_idempotency_key(self, key: str) -> Refund | None:
        result = await self.session.execute(
            select(Refund).where(Refund.idempotency_key == key)
        )
        return result.scalar_one_or_none()

    async def request_refund(
        self,
        order_id: uuid.UUID,
        *,
        ticket_ids: list[uuid.UUID] | None = None,
        amount: float | None = None,
        reason: str,
        initiated_by: str = "user",
        initiated_by_user_id: uuid.UUID | None = None,
        idempotency_key: str | None = None,
        force_auto_approve: bool = False,
    ) -> Refund:
        """환불 요청 생성.

        금액이 REFUND_AUTO_APPROVE_LIMIT 이하면 자동 승인 → PG 환불 즉시 진행.
        초과 시 PENDING 상태로 생성 → admin 승인 필요.
        """
        # 0. Idempotency 검증
        if idempotency_key:
            existing = await self._find_by_idempotency_key(idempotency_key)
            if existing:
                return existing

        # 1. 주문 상태 검증
        order = await self._get_order_for_update(order_id, load_event=True)
        if order.status not in (OrderStatus.CONFIRMED, OrderStatus.PAID):
            raise RefundError(f"Cannot refund order in status '{order.status.value}'")

        # 2. 티켓 검증 — FOR UPDATE로 잠금 (환불+양도 동시 공격 차단)
        tickets = await self._get_order_tickets(order_id, lock=True)
        if ticket_ids:
            target_tickets = [t for t in tickets if t.id in ticket_ids]
            if len(target_tickets) != len(ticket_ids):
                raise RefundError("Some ticket IDs not found in this order")
        else:
            target_tickets = [t for t in tickets if t.status != TicketStatus.CANCELLED]

        if not target_tickets:
            raise RefundError("No refundable tickets remain in this order")

        for ticket in target_tickets:
            if ticket.status == TicketStatus.USED:
                raise RefundError(f"Ticket {ticket.id} already checked in")
            if ticket.status == TicketStatus.CANCELLED:
                raise RefundError(f"Ticket {ticket.id} already refunded")

        await self._ensure_refund_ticket_ownership(order=order, tickets=target_tickets)

        # 2-b. 같은 티켓이 진행 중 환불(PENDING/APPROVED/PROCESSING)에 이미
        # 포함돼 있으면 차단 — PENDING 환불은 티켓 상태를 바꾸지 않으므로
        # 위의 status 검사만으로는 이중 요청을 못 막는다 (M-3).
        in_flight = await get_active_refund_ticket_ids(
            self.session, [t.id for t in target_tickets]
        )
        if in_flight:
            raise RefundError(
                "Refund blocked: a refund request is already in progress for these tickets"
            )

        # 3. 누적 상한 검증 — COMPLETED(total_refunded) 뿐 아니라 진행 중
        # (PENDING/APPROVED/PROCESSING) 환불 예약분까지 차감해야
        # "요청 N건 쌓고 전부 승인" 이중 환불이 막힌다 (M-3).
        reserved = await get_reserved_refund_total(self.session, order_id)
        max_refundable = (
            Decimal(str(order.total_amount))
            - Decimal(str(order.total_refunded))
            - reserved
        )
        selected_ticket_total = sum((Decimal(str(t.purchase_price)) for t in target_tickets), Decimal("0"))
        if amount is not None:
            refund_amount = Decimal(str(amount))
        else:
            refund_amount = selected_ticket_total

        if ticket_ids:
            if abs(refund_amount - selected_ticket_total) > Decimal("0.01"):
                raise RefundError("Refund amount must match the selected tickets total")
        elif abs(refund_amount - selected_ticket_total) > Decimal("0.01"):
            raise RefundError("Partial amount refunds require explicit ticket_ids")

        if refund_amount <= 0:
            raise RefundError("Refund amount must be greater than 0")
        if refund_amount > max_refundable + Decimal("0.01"):
            raise RefundError(f"Exceeds refundable amount: {max_refundable:.2f}")

        # 3-b. 공통 정책 게이트 — 취소 수수료 + 금액별 승인 요구
        # (PartialRefundService 와 동일한 게이트를 공유한다)
        event: Event | None = getattr(order, "event", None)
        policy = apply_refund_policy(
            event=event,
            gross_amount=refund_amount,
            force_auto_approve=force_auto_approve,
        )
        if policy.fee_pct > 0:
            logger.info(
                "취소 수수료 적용: order=%s fee_pct=%.1f%% fee=%s refund=%s",
                order_id, policy.fee_pct, policy.cancellation_fee, policy.refund_amount,
            )
        refund_amount = policy.refund_amount

        # 4. Refund + RefundItem 생성. FULL/PARTIAL은 지급액이 아니라 취소 범위다.
        # 취소 수수료가 있으면 실제 지급액은 주문액보다 작아도 모든 티켓의 계약이 끝난다.
        refundable_ticket_ids = {t.id for t in tickets if t.status != TicketStatus.CANCELLED}
        is_full = {t.id for t in target_tickets} == refundable_ticket_ids
        needs_approval = policy.requires_approval

        refund = Refund(
            order_id=order_id,
            idempotency_key=idempotency_key,
            refund_type=RefundType.FULL if is_full else RefundType.PARTIAL,
            amount=refund_amount,
            currency=order.payment_currency,
            reason=reason[:300],
            initiated_by=initiated_by,
            initiated_by_user_id=initiated_by_user_id,
            requires_approval=needs_approval,
            status=RefundStatus.PENDING if needs_approval else RefundStatus.APPROVED,
        )
        self.session.add(refund)

        for ticket in target_tickets:
            refund.items.append(
                RefundItem(
                    ticket_id=ticket.id,
                    seat_id=ticket.seat_id,
                    amount=ticket.purchase_price,
                    ticket_status_before=ticket.status.value if hasattr(ticket.status, "value") else str(ticket.status),
                    ticket_status_after="cancelled",
                )
            )

        await self.session.flush()

        # 5. 자동 승인이면 즉시 PG 환불
        if not needs_approval:
            await self._process_pg_refund(refund, order, target_tickets)

        # 6. 감사 로그
        await write_audit_log(
            self.session,
            actor_id=initiated_by_user_id,
            action="refund.requested" if needs_approval else "refund.auto_approved",
            resource_type="refund",
            resource_id=str(refund.id),
            event_id=order.event_id,
            new_value={
                "amount": float(refund_amount),
                "reason": reason[:200],
                "requires_approval": needs_approval,
                "is_partial": not is_full,
                "order_id": str(order_id),
            },
        )

        # 7. 승인 필요 시 운영 알림
        if needs_approval:
            try:
                await send_ops_alert("warning", "환불 승인 요청", {
                    "주문": str(order_id)[:8],
                    "금액": f"{refund_amount:,.0f}원",
                    "사유": reason[:100],
                })
            except Exception:
                logger.warning("ops refund alert failed", exc_info=True)

        return refund

    async def approve_refund(
        self,
        refund_id: uuid.UUID,
        *,
        admin_id: uuid.UUID,
    ) -> Refund:
        """admin이 환불 승인 → PG 환불 진행.

        승인 시점 재검증 (M-3 이중 환불 방어):
        요청 시점 검증만 믿으면, 같은 주문/티켓으로 쌓인 PENDING 환불 여러 건이
        모두 승인되거나, 요청 후 다른 경로로 이미 환불된 주문이 또 환불된다.
        Refund → Order → Ticket 순으로 FOR UPDATE 잠금을 잡은 뒤
        (1) 티켓이 아직 환불/체크인되지 않았는지,
        (2) 환불 가능액(total − total_refunded − 다른 진행 중 환불)이
            여전히 충분한지 재검증한다.
        동시 승인 race: 두 승인 트랜잭션은 서로 다른 Refund 행을 잡아도
        같은 Order 행 잠금에서 직렬화되므로, 두 번째 트랜잭션은 첫 번째의
        커밋 결과(total_refunded 증가·COMPLETED 전환)를 본 뒤 재검증에서 실패한다.
        """
        result = await self.session.execute(
            select(Refund)
            .where(Refund.id == refund_id)
            .options(selectinload(Refund.items))
            .with_for_update()
        )
        refund = result.scalar_one_or_none()
        if not refund:
            raise RefundError("Refund not found")
        if refund.status != RefundStatus.PENDING:
            raise RefundError("Only pending refunds can be approved")

        # 주문·티켓 잠금 (재검증은 반드시 잠금 획득 *이후* 의 데이터로)
        order = await self._get_order_for_update(refund.order_id)
        tickets = await self._get_order_tickets(refund.order_id, lock=True)
        target_ticket_ids = {item.ticket_id for item in refund.items}
        target_tickets = [t for t in tickets if t.id in target_ticket_ids]

        # 재검증 1: 티켓 상태 — 이미 취소(=다른 환불 완료)/체크인된 티켓 차단
        for ticket in target_tickets:
            if ticket.status == TicketStatus.CANCELLED:
                raise RefundError(
                    f"Cannot approve: ticket {ticket.id} already refunded"
                )
            if ticket.status == TicketStatus.USED:
                raise RefundError(
                    f"Cannot approve: ticket {ticket.id} already checked in"
                )

        # 재검증 2: 환불 가능액 — 자신을 제외한 "지급 확정"(APPROVED/PROCESSING)
        # 환불 예약분까지 차감. 다른 PENDING 요청은 각자의 승인 시점에 막힌다.
        reserved = await get_reserved_refund_total(
            self.session,
            refund.order_id,
            exclude_refund_id=refund.id,
            statuses=COMMITTED_REFUND_STATUSES,
        )
        max_refundable = (
            Decimal(str(order.total_amount))
            - Decimal(str(order.total_refunded))
            - reserved
        )
        if Decimal(str(refund.amount)) > max_refundable + Decimal("0.01"):
            raise RefundError(
                f"Cannot approve: refund amount {refund.amount} exceeds "
                f"refundable balance {max_refundable:.2f}"
            )

        refund.status = RefundStatus.APPROVED
        refund.approved_by = admin_id
        refund.approved_at = self._now()

        await self._process_pg_refund(refund, order, target_tickets)

        await write_audit_log(
            self.session,
            actor_id=admin_id,
            action="refund.approved",
            resource_type="refund",
            resource_id=str(refund_id),
            event_id=order.event_id,
            old_value={"status": "pending"},
            new_value={"status": refund.status, "amount": float(refund.amount)},
        )

        return refund

    async def reject_refund(
        self,
        refund_id: uuid.UUID,
        *,
        admin_id: uuid.UUID,
        rejection_reason: str,
    ) -> Refund:
        """admin이 환불 거부."""
        result = await self.session.execute(
            select(Refund)
            .where(Refund.id == refund_id)
            .options(selectinload(Refund.items))
            .with_for_update()
        )
        refund = result.scalar_one_or_none()
        if not refund:
            raise RefundError("Refund not found")
        if refund.status != RefundStatus.PENDING:
            raise RefundError("Only pending refunds can be rejected")

        refund.status = RefundStatus.REJECTED
        refund.rejection_reason = rejection_reason[:300]

        order = await self._get_order_for_update(refund.order_id)

        await write_audit_log(
            self.session,
            actor_id=admin_id,
            action="refund.rejected",
            resource_type="refund",
            resource_id=str(refund_id),
            event_id=order.event_id,
            new_value={"reason": rejection_reason[:200]},
        )

        # 유저에게 거부 알림
        try:
            from app.models.notification import NotificationModel
            notification = NotificationModel(
                user_id=order.user_id,
                type="refund_rejected",
                message=f"환불 요청이 거부되었습니다. 사유: {rejection_reason[:100]}",
                data={
                    "refund_id": str(refund_id),
                    "order_id": str(order.id),
                    "reason": rejection_reason[:200],
                },
            )
            self.session.add(notification)
        except Exception:
            logger.warning("환불 거부 알림 발송 실패: refund=%s", refund_id)

        return refund

    async def _process_pg_refund(
        self,
        refund: Refund,
        order: Order,
        target_tickets: list[Ticket],
    ) -> None:
        """실제 PG 환불 실행.

        2단계 구조 (이중 환불 방지):
          1) PG 호출 → 성공 시 즉시 COMPLETED 마킹 + flush.
             PG 호출 자체가 실패하면 FAILED + raise (돈은 안 빠졌으므로 재시도 가능).
          2) 후처리(티켓 취소/sold_count 복구/좌석 해제/order 갱신/알림)는
             best-effort. 후처리 실패가 COMPLETED 를 되돌리거나 재환불을
             유발하면 안 되므로 try/except 로 감싸 로깅+알림만 하고 re-raise 안 함.
        """
        refund.status = RefundStatus.PROCESSING

        # ── M-3 과환불 방어: PG 호출 전에 상한 검증 ──
        # PG 에러에 의존하지 않고 우리 원장 기준으로 선차단한다.
        # remaining(PG측 취소 가능 잔액)에서 "자신을 제외한" 지급 확정
        # (APPROVED/PROCESSING) 환불 예약분까지 차감해야 동시·중복 승인
        # 경로에서도 이중 환불이 차단된다.
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
            raise RefundError(
                f"Refund amount {refund_amount} exceeds refundable balance {available:.2f}"
            )

        # M-3: PG에는 실제 환불액(수수료 차감/부분 환불 반영)을 전달한다.
        # 잔액 전체 환불이면 None(전액 취소), 아니면 부분 취소 금액을 명시.
        # (full/partial 판단 기준은 예약분이 아닌 PG측 실제 잔액 remaining)
        is_full_cancel = refund_amount >= remaining - Decimal("0.01")
        # 전액취소 전문은 부분환불 이력이 없을 때만 — 이력이 있으면 PG 취소가능잔액과
        # 원거래 총액이 달라 전문이 거절된다(resolve_cancel_amount 주석 참조).
        cancel_amount = resolve_cancel_amount(order, refund_amount, is_full=is_full_cancel)

        # ── 1단계: PG 호출 (실패 시에만 FAILED + raise) ──
        try:
            if order.payment_id:
                pg_result = await self._void_order_payment(
                    order,
                    payment_id=order.payment_id,
                    reason=refund.reason,
                    amount=cancel_amount,
                )
                # 🔴 PG 는 **거절을 예외가 아니라 반환값으로** 알린다
                #    (nicepay_gateway: `voided = status_norm == "cancelled"` — 취소불가 시간대·
                #     한도초과·이미취소 등은 HTTP 200 + 실패 ResultCode 로 온다).
                #    이 값을 안 보면 **돈은 PG 에 남았는데 원장은 환불완료**가 되고,
                #    티켓 취소·재고 환원·total_refunded 증가까지 전부 진행된다.
                #    게이트웨이 주석도 "호출부가 voided=True 여야 성공 처리" 를 명시한다.
                if not getattr(pg_result, "voided", False):
                    raise RefundError(
                        "PG 취소가 거절되었습니다(voided=False). 환불을 확정하지 않습니다: "
                        f"{getattr(pg_result, 'raw', {})}"
                    )
                refund.pg_refund_id = getattr(pg_result, "transaction_id", None)
                refund.pg_response = getattr(pg_result, "raw", {})
            else:
                refund.pg_response = {"mock": True, "note": "No payment_id"}
        except PartialCancelUnsupportedError as e:
            # 🔴 부분취소 가드 — 전문을 보내기 전에 끊은 것이라 **돈은 움직이지 않았다**.
            #    PG 장애가 아니므로 critical 운영알럿을 울리지 않는다(울리면 진짜 사고가
            #    묻힌다). 환불은 FAILED 로 남기고 사유를 그대로 올린다.
            refund.status = RefundStatus.FAILED
            refund.pg_response = {"error": str(e), "guard": "partial_cancel_blocked"}
            logger.info("부분취소 차단: order=%s refund=%s", order.id, refund.id)
            raise RefundError(str(e)) from e
        except Exception as e:
            refund.status = RefundStatus.FAILED
            refund.pg_response = {"error": str(e)}

            try:
                await send_ops_alert("critical", "PG 환불 실패", {
                    "refund_id": str(refund.id),
                    "order_id": str(order.id),
                    "amount": float(refund.amount),
                    "error": str(e),
                }, mention=True)
            except Exception:
                logger.warning("ops PG failure alert failed", exc_info=True)

            raise RefundError(f"PG refund failed: {e}") from e

        # PG 성공 — 즉시 COMPLETED 확정 후 flush.
        # 이 시점 이후 후처리가 실패해도 환불은 이미 PG에서 완료됐으므로
        # 절대 재시도/재환불하면 안 된다.
        refund.status = RefundStatus.COMPLETED
        refund.processed_at = self._now()
        try:
            await self.session.flush()
        except Exception:
            logger.error(
                "환불 COMPLETED flush 실패: refund=%s (PG는 이미 완료) — 후처리 계속",
                refund.id,
                exc_info=True,
            )

        # ── 2단계: 후처리 (best-effort) ──
        # SAVEPOINT 로 감싼다: 후처리 중 flush 실패가 세션을 deactive 상태로 만들면
        # 바깥 트랜잭션의 COMPLETED commit 까지 깨져서, PG는 환불했는데 DB는 여전히
        # PROCESSING 으로 남아 재환불 위험이 생긴다. savepoint 면 후처리 실패가
        # 롤백되어도 (1단계에서 flush 한) COMPLETED 와 세션은 살아남는다.
        is_full_refund = False
        post_ok = False
        try:
            async with self.session.begin_nested():
                # 티켓 상태 변경
                for ticket in target_tickets:
                    ticket.status = TicketStatus.CANCELLED

                # 환불로 죽은 티켓의 재판매 listing 정리 (환불↔재판매 정합).
                # 환불된 티켓은 더 이상 판매 불가이므로, ACTIVE/MATCHED(미결제)
                # listing 을 같은 트랜잭션에서 CANCELLED 로 전이한다.
                await self._cancel_resale_listings(target_tickets)

                await self._decrement_sold_counts(target_tickets)
                await self._release_seats(target_tickets)

                # Order 업데이트 — 원자적 증가로 동시 환불 시 값 덮어쓰기 방지
                await self.session.execute(
                    update(Order)
                    .where(Order.id == order.id)
                    .values(total_refunded=Order.total_refunded + Decimal(str(refund.amount)))
                )
                await self.session.refresh(order, ["total_refunded"])
                # RefundType은 티켓 취소 범위의 정본이다. 수수료 차감 전체취소는
                # total_refunded < total_amount 여도 주문 계약은 종료된다.
                is_full_refund = refund.refund_type == RefundType.FULL
                if is_full_refund:
                    order.status = OrderStatus.REFUNDED
            post_ok = True
        except Exception as e:
            # 후처리 실패: 환불은 이미 PG+DB에서 COMPLETED. 절대 re-raise/재환불 금지.
            logger.error(
                "환불 후처리 실패 (환불은 이미 COMPLETED): refund=%s order=%s err=%s",
                refund.id, order.id, e, exc_info=True,
            )
            try:
                await send_ops_alert("critical", "환불 후처리 실패 (수동 정리 필요)", {
                    "refund_id": str(refund.id),
                    "order_id": str(order.id),
                    "amount": float(refund.amount),
                    "error": str(e),
                    "note": "PG 환불은 완료됨. 티켓/좌석/sold_count 수동 정리 필요.",
                }, mention=True)
            except Exception:
                logger.warning("ops 후처리 실패 alert failed", exc_info=True)

        # propagation/알림은 후처리 savepoint 가 커밋된 경우에만 — DB 상태와
        # 메모리 propagation list 의 정합을 보장 (롤백된 후처리를 go 로 흘리지 않음).
        if post_ok:
            self.propagations.append({
                "event": "order.refunded",
                "order_id": str(order.id),  # 🔴 UUID 그대로면 워커가 json.dumps 에서 죽는다
                "data": {
                    "refund_id": str(refund.id),
                    "refund_amount": float(refund.amount),
                    # 🔴 float 로 통일 (2026-08-01). partial_refund_service 는 float 인데
                    # 여기만 str 이라 go 가 두 타입을 다 받아야 했다. go 는 Number() 로
                    # 읽지만, 계약이 갈려 있으면 다음 소비자가 밟는다.
                    "total_refunded": float(order.total_refunded),
                    "original_amount": float(order.total_amount),
                    "is_full_refund": is_full_refund,
                    "reason": (refund.reason or "")[:200],
                    "pg_refund_id": refund.pg_refund_id,
                    "refunded_at": refund.processed_at.isoformat() if refund.processed_at else None,
                    "source_product": "consumer",
                },
            })

            # 유저 알림
            try:
                from app.models.notification import NotificationModel
                is_guest = order.user_id is None
                notification_data = {
                    "refund_id": str(refund.id),
                    "order_id": str(order.id),
                    "amount": float(refund.amount),
                }
                if is_guest:
                    notification_data.update({
                        "channel": "email",
                        "to_email": order.buyer_email,
                    })
                notification = NotificationModel(
                    user_id=order.user_id,
                    guest_id=order.guest_id if is_guest else None,
                    type="refund_complete",
                    message=f"환불이 완료되었습니다. ({float(refund.amount):,.0f}원)",
                    data=notification_data,
                )
                self.session.add(notification)
            except Exception:
                logger.warning("환불 완료 알림 발송 실패: refund=%s", refund.id)

    async def _decrement_sold_counts(self, tickets: list[Ticket]) -> None:
        """Refunded tickets must also return tier inventory."""
        import os

        from app.services import inventory_service

        # sold_count: PostgreSQL 은 trg_sync_sold_count 트리거가 ticket→cancelled 시 자동 -1.
        # 명시적 decrement_sold 를 함께 호출하면 이중감소(oversell 위험) → 구매 경로와 동일하게
        # SQLite(test, 트리거 없음)에서만 수동 감소. (inventory_service=Redis 별도 카운터라 항상 release)
        manual_sold = bool(os.environ.get("PYTEST_CURRENT_TEST"))

        quantity_by_tier: dict[uuid.UUID, int] = {}
        for ticket in tickets:
            quantity_by_tier[ticket.tier_id] = quantity_by_tier.get(ticket.tier_id, 0) + 1

        for tier_id, quantity in quantity_by_tier.items():
            if manual_sold:
                await self.tier_repo.decrement_sold(tier_id, quantity)
            await inventory_service.release(tier_id, quantity)

    async def _cancel_resale_listings(self, tickets: list[Ticket]) -> None:
        """환불로 CANCELLED 된 티켓의 재판매 listing 정리 (결함1).

        환불 후 ticket=CANCELLED 인데 그 티켓의 ResaleListing 이 ACTIVE 로 남으면,
        매칭 배치가 매 주기 죽은 listing 을 fetch→취소하는 churn 이 생기고
        짧은 윈도우 동안 시세/주문서에 유령 ask 가 노출된다.

        전이 대상:
          - ACTIVE: 아직 매칭 전 — 즉시 CANCELLED.
          - MATCHED: 매칭됐지만 미결제(buyer Order=PAYMENT_REQUIRED) — 결제 확정
            전이므로 CANCELLED. (확정되면 listing→SOLD 로 빠지고, 그때는
            소유권이 buyer 로 넘어가 _ensure_refund_ticket_ownership 가 애초에
            원 구매자의 환불을 차단하므로 여기 도달하지 않는다.)
          - SOLD/EXPIRED/CANCELLED: 건드리지 않는다.

        MATCHED listing 정리(결함2 보완):
          MATCHED listing 에는 _execute_trade 가 만든 구매자 측 부산물이 둘 있다:
            1. RESALE_BUY Order (orders, status=PAYMENT_REQUIRED) — 구매자 결제 대기
            2. ResaleBuyOrderModel (bid, status=MATCHED) — 매칭에 소진된 매수 호가
          listing 만 CANCELLED 하고 이 둘을 방치하면, 구매자가 잔존 주문으로 결제를
          시도→PG 청구 성공→_resale_ticket_unsellable_reason 이 ticket=CANCELLED 를
          감지→즉시 자동 환불 하는 불필요한 청구-즉시환불 사이클(PG 수수료 이중)이
          생긴다. 따라서 같은 savepoint 안에서:
            - 구매자 RESALE_BUY 주문(PAYMENT_REQUIRED) → CANCELLED
            - 구매자 bid(MATCHED) → ACTIVE 복원 (get_highest_bid 가 ACTIVE 만 fetch
              하므로, 다른 살아있는 listing 과 재매칭 가능해진다)
          이미 CONFIRMED/AUTHORIZED 된 주문은 건드리지 않는다 — 결제 확정 경로면
          listing 이 SOLD 라 애초에 이 함수의 전이 대상이 아니고, 소유권이 buyer 로
          넘어가 원 구매자 환불 자체가 _ensure_refund_ticket_ownership 에서 차단된다.

        순환 import 방지를 위해 resale 모델은 함수 내 지연 import (payment_service /
        chargeback_service 와 동일 패턴). 같은 환불 후처리 savepoint 안에서
        원자적으로 실행된다.
        """
        ticket_ids = [t.id for t in tickets]
        if not ticket_ids:
            return

        from app.models.resale import (
            ResaleBuyOrderModel,
            ResaleBuyOrderStatus,
            ResaleListingModel,
            ResaleListingStatus,
        )

        # MATCHED listing 은 연결된 구매자 주문/bid 정리를 위해 ID 가 필요하므로
        # 먼저 조회한 뒤 전이한다. (ACTIVE 는 부산물이 없어 ID 불필요)
        matched_result = await self.session.execute(
            select(ResaleListingModel.id).where(
                ResaleListingModel.ticket_id.in_(ticket_ids),
                ResaleListingModel.status == ResaleListingStatus.MATCHED,
            )
        )
        matched_listing_ids = [row[0] for row in matched_result.all()]

        # ACTIVE/MATCHED listing → CANCELLED (단일 원자 UPDATE)
        await self.session.execute(
            update(ResaleListingModel)
            .where(
                ResaleListingModel.ticket_id.in_(ticket_ids),
                ResaleListingModel.status.in_(
                    (ResaleListingStatus.ACTIVE, ResaleListingStatus.MATCHED)
                ),
            )
            .values(status=ResaleListingStatus.CANCELLED)
        )

        if not matched_listing_ids:
            return

        # MATCHED listing 에 매칭된 구매자 주문 정리.
        # 주문↔listing 연결은 payment_metadata.resale.listing_id (역방향 조회).
        # JSON path WHERE 는 DB(SQLite/PG)별로 달라, MATCHED 건수가 작은(티켓당
        # 최대 1) 이 경로에서는 후보 주문을 fetch 해 Python 에서 필터한다.
        matched_id_strs = {str(lid) for lid in matched_listing_ids}
        candidate_orders = await self.session.execute(
            select(Order).where(
                Order.order_type == OrderType.RESALE_BUY,
                Order.status == OrderStatus.PAYMENT_REQUIRED,
            )
        )
        bid_ids_to_restore: list[uuid.UUID] = []
        for buy_order_record in candidate_orders.scalars().all():
            meta = buy_order_record.payment_metadata
            if not isinstance(meta, dict):
                continue
            resale_meta = meta.get("resale") or {}
            listing_id = resale_meta.get("listing_id")
            if listing_id not in matched_id_strs:
                continue
            # 구매자 미결제 주문 → CANCELLED (PAYMENT_REQUIRED→CANCELLED 정합)
            buy_order_record.status = OrderStatus.CANCELLED
            # 매칭에 소진된 bid 복원 대상 수집
            bid_id = resale_meta.get("buy_order_id")
            if bid_id:
                try:
                    bid_ids_to_restore.append(uuid.UUID(bid_id))
                except (ValueError, TypeError):
                    logger.warning(
                        "환불 resale 정리: 잘못된 buy_order_id=%s order=%s",
                        bid_id, buy_order_record.id,
                    )

        # 구매자 bid(MATCHED) → ACTIVE 복원 (재매칭 가능). 이미 다른 상태로
        # 진행된 bid 는 건드리지 않도록 status=MATCHED 만 전이한다.
        if bid_ids_to_restore:
            await self.session.execute(
                update(ResaleBuyOrderModel)
                .where(
                    ResaleBuyOrderModel.id.in_(bid_ids_to_restore),
                    ResaleBuyOrderModel.status == ResaleBuyOrderStatus.MATCHED,
                )
                .values(status=ResaleBuyOrderStatus.ACTIVE)
            )

    async def _release_seats(self, tickets: list[Ticket]) -> None:
        """환불된 티켓의 좌석 해제."""
        seat_ids = [t.seat_id for t in tickets if t.seat_id]
        if not seat_ids:
            return
        try:
            from app.repositories.seat_repo import SeatRepository
            seat_repo = SeatRepository(self.session)
            await seat_repo.release_sold(seat_ids)
        except Exception:
            logger.warning("좌석 해제 실패: seats=%s", seat_ids)

    async def get_pending_refunds(
        self,
        *,
        skip: int = 0,
        limit: int = 50,
    ) -> list[Refund]:
        """승인 대기 환불 목록 조회."""
        result = await self.session.execute(
            select(Refund)
            .where(Refund.status == RefundStatus.PENDING)
            .options(selectinload(Refund.items))
            .order_by(Refund.requested_at.asc())
            .offset(skip)
            .limit(limit)
        )
        return list(result.scalars().all())
