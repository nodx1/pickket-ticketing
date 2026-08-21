"""
Purchase Service
=================
FCFS + fanclub purchase flow with PostgreSQL row locking.
Redis distributed lock should be acquired at the API router level.

Also provides standalone async functions for SQS event processing:
- persist_order_from_hold: Creates an Order row from a Go Redis-only hold.
- finalize_payment: Marks an order as PAID and activates its tickets.
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.services import inventory_service
from talkfile_engine.sale_modes import PurchaseRequest as EnginePurchaseRequest
from talkfile_engine.group_tickets import (
    GroupRequest as EngineGroupRequest,
    validate_no_cross_group,
)
from talkfile_engine.multi_session import check_multi_session_limit, SessionHistory, SessionRecord

from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus, OrderType
from app.models.ticket import Ticket, TicketStatus
from app.models.ownership_transfer import OwnershipTransfer, TransferType
from app.core.audit import write_audit_log
from app.models.session_history import SessionHistoryModel
from app.repositories.event_repo import EventRepository, SeatTierRepository
from app.repositories.ticket_repo import TicketRepository
from app.repositories.order_repo import OrderRepository
from app.repositories.seat_repo import SeatRepository
from app.schemas.order import OrderCreate
from app.schemas.purchase import PurchaseResponse
from app.core.config import settings
from app.services.order_service import OrderService


logger = logging.getLogger(__name__)

# U4(판매게이트 SSOT): 판매가능 status 는 commerce_status 가 정본. consumer marketplace
# 경로(이 서비스)와 go/게스트 원자주문 경로(_do_create_order)가 동일 집합을 참조 →
# go 폐기 후에도 v2 단일 판정. (frozenset → 기존 `not in`/`in` 사용부 무변.)
from app.core.commerce_status import PURCHASABLE_EVENT_STATUSES as PURCHASABLE_STATUSES


class PurchaseError(Exception):
    """Purchase validation error."""


class PurchaseService:
    """Service for FCFS and fanclub fixed-price purchases."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.event_repo = EventRepository(session)
        self.tier_repo = SeatTierRepository(session)
        self.ticket_repo = TicketRepository(session)
        self.order_repo = OrderRepository(session)
        self.seat_repo = SeatRepository(session)
        self.order_service = OrderService(session)

    async def _validate_event_purchasable(self, event_id: uuid.UUID) -> Event:
        """이벤트 상태 및 판매창 검증. 구매 불가 시 PurchaseError 발생."""
        event = await self.event_repo.get(event_id)
        if not event:
            raise PurchaseError("Event not found")

        if event.status == EventStatus.CANCELLED:
            raise PurchaseError("Event has been cancelled")

        # go "paused"(주최자 판매 일시중지) — status-독립. 재개 시 직전 상태 그대로.
        # (Boolean 컬럼은 네이티브 bool → is True 로 명시 비교)
        if getattr(event, "sales_paused", False) is True:
            raise PurchaseError("Sales are temporarily paused")

        if event.status not in PURCHASABLE_STATUSES:
            raise PurchaseError(
                f"Event not available for purchase (status: {event.status.value})"
            )

        # ── Phase 0 채널 gate (v2 단일 SoT cutover) ──
        # v2/app(marketplace 채널)은 marketplace 행사만 판매한다. self 전용 행사는
        # go 랜딩(/e/[slug])에서만 팔리므로 v2 구매를 차단 — 채널 이중판매(split-brain)
        # 방지. both 행사는 marketplace ∈ channels 이므로 통과(P3 재고 단일화로 정합).
        if "marketplace" not in (event.sale_channels or []):
            raise PurchaseError("이 행사는 마켓플레이스 판매 대상이 아닙니다 (self 전용 채널)")

        now = datetime.now(timezone.utc)

        # APPROVED → BIDDING_OPEN auto-transition when sales window is open
        if event.status == EventStatus.APPROVED:
            opens_at = event.bidding_opens_at
            if opens_at and opens_at.tzinfo is None:
                opens_at = opens_at.replace(tzinfo=timezone.utc)
            if opens_at and now < opens_at:
                raise PurchaseError("Sales window not yet open")
            # Sales window is open — transition to BIDDING_OPEN
            from sqlalchemy import update
            await self.session.execute(
                update(Event)
                .where(Event.id == event.id)
                .values(status=EventStatus.BIDDING_OPEN)
            )
            event.status = EventStatus.BIDDING_OPEN
            # Invalidate caches
            try:
                from app.api.v1.events import _invalidate_event_caches
                await _invalidate_event_caches(event.id)
            except Exception:
                pass

        if event.bidding_opens_at:
            opens_at = event.bidding_opens_at
            if opens_at.tzinfo is None:
                opens_at = opens_at.replace(tzinfo=timezone.utc)
            if now < opens_at:
                raise PurchaseError("Sales window not yet open")

        if event.bidding_closes_at:
            closes_at = event.bidding_closes_at
            if closes_at.tzinfo is None:
                closes_at = closes_at.replace(tzinfo=timezone.utc)
            if now > closes_at:
                raise PurchaseError("Sales window has closed")

        return event

    async def _check_per_user_quantity(
        self,
        user_id: uuid.UUID,
        tier_id: uuid.UUID,
        tier: "SeatTier",
        quantity: int,
    ) -> tuple[bool, str]:
        """Per-user purchase limit check (prevents split-request abuse).

        Sums quantity across all active/pending orders for this user+tier.
        Must be called inside the row-lock section to prevent race conditions.

        Returns:
            (ok, message) — ok=True if within limit, False otherwise.
        """
        existing_qty_result = await self.session.execute(
            select(func.coalesce(func.sum(Order.quantity), 0)).where(
                Order.user_id == user_id,
                Order.tier_id == tier_id,
                Order.status.in_([
                    OrderStatus.PAYMENT_REQUIRED,
                    OrderStatus.CONFIRMED,
                    OrderStatus.PAID,
                ]),
            )
        )
        existing_qty: int = existing_qty_result.scalar() or 0
        max_per_user = tier.max_group_size or 4
        if existing_qty + quantity > max_per_user:
            return False, (
                f"Per-user limit exceeded: you already have {existing_qty} "
                f"ticket(s) for this tier (max {max_per_user})"
            )
        return True, ""

    async def _check_multi_session_limit(
        self, user_id: uuid.UUID, event_id: uuid.UUID
    ) -> tuple[bool, str]:
        """
        Check multi-session win limit for a user before purchase.

        Loads the event's artist_id and session history from DB,
        then delegates to engine check_multi_session_limit().

        Returns:
            (eligible, reason) tuple.
        """
        from sqlalchemy import select

        event = await self.event_repo.get(event_id)
        if not event or not event.artist_id:
            return True, "No multi-session constraint (no artist_id)"

        artist_id = str(event.artist_id)
        max_wins = event.multi_max_wins_per_user

        # Load session history from DB
        result = await self.session.execute(
            select(SessionHistoryModel).where(
                SessionHistoryModel.user_id == user_id,
                SessionHistoryModel.artist_id == artist_id,
            )
        )
        db_records = list(result.scalars().all())

        engine_history = SessionHistory()
        for record in db_records:
            engine_history.add_record(
                SessionRecord(
                    user_id=str(record.user_id),
                    artist_id=record.artist_id,
                    session_number=record.session_number,
                    event_id=str(record.event_id),
                    participated=record.participated,
                    won=record.won,
                    tier_id=str(record.tier_id) if record.tier_id else "",
                    price_paid=record.price_paid,
                )
            )

        return check_multi_session_limit(
            history=engine_history,
            user_id=str(user_id),
            artist_id=artist_id,
            max_wins=max_wins,
        )

    @staticmethod
    def _validate_group_request(
        group_id: uuid.UUID | None,
        leader_user_id: uuid.UUID,
        member_user_ids: list[uuid.UUID] | None,
        tier: SeatTier,
    ) -> tuple[bool, str]:
        """
        Validate a group ticket request using engine GroupRequest.validate().

        Returns:
            (is_valid, reason) tuple.
        """
        if not group_id or not member_user_ids:
            return True, "Not a group purchase"

        engine_group = EngineGroupRequest(
            group_id=str(group_id),
            leader_user_id=str(leader_user_id),
            member_user_ids=[str(uid) for uid in member_user_ids],
            tier_id=str(tier.id),
        )

        return engine_group.validate(max_group_size=tier.max_group_size)

    @staticmethod
    def validate_no_cross_group_purchases(
        groups: list[dict],
    ) -> tuple[bool, str]:
        """
        Validate that no user appears in multiple groups for the same event.

        Args:
            groups: List of dicts with 'group_id', 'leader_user_id', 'member_user_ids'.

        Returns:
            (is_valid, reason) tuple.
        """
        engine_groups = [
            EngineGroupRequest(
                group_id=str(g["group_id"]),
                leader_user_id=str(g["leader_user_id"]),
                member_user_ids=[str(uid) for uid in g["member_user_ids"]],
            )
            for g in groups
        ]
        return validate_no_cross_group(engine_groups)

    async def purchase_fcfs(
        self,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
        quantity: int,
        group_id: uuid.UUID | None = None,
        seat_ids: list[uuid.UUID] | None = None,
        time_slot_start: datetime | None = None,
        time_slot_end: datetime | None = None,
    ) -> PurchaseResponse:
        """
        Execute a first-come-first-served purchase.

        Assumes Redis lock is already held by the caller (API router).
        Uses PostgreSQL row-level locking (SELECT FOR UPDATE) on the tier.

        Args:
            user_id: Purchasing user's UUID.
            event_id: Event UUID.
            tier_id: Seat tier UUID.
            quantity: Number of tickets to purchase.
            group_id: Optional group purchase identifier.

        Returns:
            PurchaseResponse with order and ticket details.
        """
        # 0a. Validate event is purchasable (status + sales window)
        try:
            await self._validate_event_purchasable(event_id)
        except PurchaseError as e:
            return PurchaseResponse(
                success=False,
                sale_mode="fixed_fcfs",
                unit_price=0.0,
                total_price=0.0,
                message=str(e),
            )

        # 0b. Check multi-session win limit
        eligible, reason = await self._check_multi_session_limit(user_id, event_id)
        if not eligible:
            return PurchaseResponse(
                success=False,
                sale_mode="fixed_fcfs",
                unit_price=0.0,
                total_price=0.0,
                message=reason,
            )

        # 1. Load tier with row lock
        tier = await self.tier_repo.get_for_update(tier_id)
        if not tier:
            return PurchaseResponse(
                success=False,
                sale_mode="fixed_fcfs",
                unit_price=0.0,
                total_price=0.0,
                message="Tier not found",
            )

        # 1a. Validate tier belongs to the requested event
        if str(tier.event_id) != str(event_id):
            return PurchaseResponse(success=False, message="Tier does not belong to this event")

        # 🔴 숨김·비활성 티어는 이 경로로 살 수 없다 (2026-08-02).
        #    marketplace 회원 구매 경로다. 지금 KLPGA 는 `{self}` 라 여기를 안 타지만,
        #    marketplace 행사에 같은 숨김 티어(초대권 0원)가 있으면 tier_id 를 아는
        #    사람이 직접 구매로 이어갈 수 있다.
        #    ⚠️ "Tier not found" 로 통일한다 — 존재 여부를 흘리면 그 자체가 탐색 단서다.
        if str(getattr(tier, "visibility", "public")).lower() != "public" or not bool(
            getattr(tier, "is_active", True)
        ):
            return PurchaseResponse(
                success=False,
                sale_mode=getattr(tier, "sale_mode", "fixed_fcfs"),
                unit_price=0.0,
                total_price=0.0,
                message="Tier not found",
            )

        # 1a-2. Validate this tier is actually sold via direct FCFS purchase.
        # point_lottery/queue/fanclub_presale 티어는 각자의 배분 플로우(추첨 응모·
        # 대기열·팬클럽 선예매)를 거쳐야 한다. 직접 구매를 허용하면 공정 추첨을
        # 우회하고(F-도메인 위반) 잘못된 가격(face_price 미설정 시 0원)으로 티켓이
        # 발급된다. 라이브 시뮬레이션에서 point_lottery 티어가 0원 직접구매로
        # 발급되던 결함을 차단한다.
        _tier_mode = getattr(tier, "sale_mode", "fixed_fcfs")
        if _tier_mode not in ("fixed_fcfs", "discount_fcfs"):
            return PurchaseResponse(
                success=False,
                sale_mode=_tier_mode,
                unit_price=0.0,
                total_price=0.0,
                message=(
                    f"이 등급은 직접 구매 대상이 아닙니다 (판매 모드: {_tier_mode}). "
                    "추첨 응모·대기열·팬클럽 선예매 등 해당 플로우를 이용하세요."
                ),
            )

        # 1b. Validate max group size
        if quantity > (tier.max_group_size or 4):
            return PurchaseResponse(success=False, message="Exceeds maximum group size")

        # 1c. Validate group request if applicable
        if group_id:
            # For FCFS, member_user_ids would come from the group_id lookup.
            # Here we validate the engine GroupRequest with the leader as the sole known member.
            EngineGroupRequest(
                group_id=str(group_id),
                leader_user_id=str(user_id),
                member_user_ids=[str(user_id)],
                tier_id=str(tier_id),
            )
            # Group validation is performed only when full member list is known;
            # single-user groups bypass validation (quantity-based group purchase).

        # 1d. Per-user purchase quantity limit (prevents split-request bypass)
        ok, msg = await self._check_per_user_quantity(user_id, tier_id, tier, quantity)
        if not ok:
            return PurchaseResponse(
                success=False,
                sale_mode="fixed_fcfs",
                unit_price=tier.face_price,
                total_price=0.0,
                message=msg,
            )

        # 2. Check remaining capacity
        remaining = tier.capacity - tier.sold_count
        if remaining < quantity:
            return PurchaseResponse(
                success=False,
                sale_mode="fixed_fcfs",
                unit_price=tier.face_price,
                total_price=0.0,
                message=f"Not enough seats: {remaining} remaining, {quantity} requested",
            )

        # 3. Validate using engine's PurchaseRequest
        engine_req = EnginePurchaseRequest(
            user_id=str(user_id),
            tier_id=str(tier_id),
            quantity=quantity,
            group_id=str(group_id) if group_id else None,
        )
        engine_req.validate()

        # 3b. Verify seat holds if seat_ids provided
        if seat_ids:
            # C3: Validate seat count matches quantity
            if len(seat_ids) != quantity:
                return PurchaseResponse(
                    success=False,
                    sale_mode="fixed_fcfs",
                    unit_price=tier.face_price,
                    total_price=0.0,
                    message="좌석 수와 수량이 일치하지 않습니다.",
                )
            # C2: Verify all seats belong to the correct tier
            for sid in seat_ids:
                seat = await self.seat_repo.get(sid)
                if not seat or seat.tier_id != tier_id:
                    return PurchaseResponse(
                        success=False,
                        sale_mode="fixed_fcfs",
                        unit_price=tier.face_price,
                        total_price=0.0,
                        message="좌석이 해당 등급에 속하지 않습니다.",
                    )
            if not await self.seat_repo.verify_and_mark_sold(seat_ids, user_id):
                return PurchaseResponse(
                    success=False,
                    sale_mode="fixed_fcfs",
                    unit_price=tier.face_price,
                    total_price=0.0,
                    message="Seat holds invalid or expired. Please re-select seats.",
                )

        unit_price = tier.face_price
        total_price = unit_price * quantity

        # 4. Create Order (instant confirmation for FCFS)
        order = await self.order_service.create_order(
            user_id=user_id,
            event_id=event_id,
            order_data=OrderCreate(
                tier_id=tier_id,
                quantity=quantity,
                time_slot_start=time_slot_start,
                time_slot_end=time_slot_end,
            ),
            unit_price=unit_price,
            total_amount=total_price,
            order_type=OrderType.PURCHASE,
            payment_deadline=datetime.now(timezone.utc)
            + timedelta(minutes=settings.PAYMENT_EXPIRY_MINUTES),
        )

        # 5. Create Tickets (batch), linking seat_ids if provided
        tickets_data = []
        for i in range(quantity):
            ticket_data = {
                "event_id": event_id,
                "tier_id": tier_id,
                "original_owner_id": user_id,
                "current_owner_id": user_id,
                "purchase_price": unit_price,
                "sale_mode": "fixed_fcfs",
                "purchase_order_id": order.id,
                "status": TicketStatus.PENDING,
                "is_resalable": tier.resale_allowed,
                "resale_max_price": tier.resale_max_price,
            }
            if seat_ids and i < len(seat_ids):
                ticket_data["seat_id"] = seat_ids[i]
            tickets_data.append(ticket_data)
        tickets = await self.ticket_repo.create_batch(tickets_data)

        # 6. Record primary sale transfers
        for ticket in tickets:
            transfer = OwnershipTransfer(
                ticket_id=ticket.id,
                from_user_id=None,
                to_user_id=user_id,
                transfer_type=TransferType.PRIMARY_SALE,
                price=unit_price,
                seller_amount=0.0,
                platform_fee=0.0,
                artist_royalty=0.0,
            )
            self.session.add(transfer)

        # 7. sold_count 관리 — PostgreSQL: DB trigger `trg_sync_sold_count` 가
        # ticket INSERT 시 자동 증가. SQLite(테스트): trigger 없으므로 수동 증가.
        import os
        if os.environ.get("PYTEST_CURRENT_TEST"):
            tier.sold_count = (tier.sold_count or 0) + quantity
            await self.session.flush()

        # 8. Audit log
        await write_audit_log(
            self.session,
            actor_id=user_id,
            action="purchase_fcfs",
            resource_type="order",
            resource_id=str(order.id),
            event_id=event_id,
            tier_id=tier_id,
            sale_mode="fixed_fcfs",
            new_value={
                "quantity": quantity,
                "unit_price": unit_price,
                "total_price": total_price,
                "order_id": str(order.id),
                "group_id": str(group_id) if group_id else None,
                "result": "success",
            },
        )

        # 9. Return response
        return PurchaseResponse(
            success=True,
            order_id=order.id,
            ticket_ids=[t.id for t in tickets],
            sale_mode="fixed_fcfs",
            unit_price=unit_price,
            total_price=total_price,
            message=f"Order created. {quantity} ticket(s) reserved. Please complete payment.",
        )

    async def purchase_fanclub(
        self,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
        quantity: int,
        seat_ids: list[uuid.UUID] | None = None,
        time_slot_start: datetime | None = None,
        time_slot_end: datetime | None = None,
    ) -> PurchaseResponse:
        """
        Execute a fanclub presale purchase with discount.

        Similar to FCFS but applies fanclub_discount_pct from the tier config.

        Args:
            user_id: Purchasing user's UUID.
            event_id: Event UUID.
            tier_id: Seat tier UUID.
            quantity: Number of tickets to purchase.
            seat_ids: Optional list of held seat UUIDs to purchase.

        Returns:
            PurchaseResponse with order and ticket details.
        """
        # 0a. Validate event is purchasable (status + sales window)
        try:
            await self._validate_event_purchasable(event_id)
        except PurchaseError as e:
            return PurchaseResponse(
                success=False,
                sale_mode="fanclub_presale",
                unit_price=0.0,
                total_price=0.0,
                message=str(e),
            )

        # 0a2. fanclub_presale 자격: 해당 event fanclub의 ACTIVE 멤버여야 한다.
        #      (MASTER N3 — v2 직접 호출 시 무자격 구매 차단. 기존엔 검증 부재로 누구나 구매 가능했음)
        from app.services.fanclub_service import FanclubService

        if not await FanclubService(self.session).is_member_for_event(user_id, event_id):
            return PurchaseResponse(
                success=False,
                sale_mode="fanclub_presale",
                unit_price=0.0,
                total_price=0.0,
                message="팬클럽 회원만 구매할 수 있습니다 (fanclub_presale 자격 없음)",
            )

        # 0b. Check multi-session win limit
        eligible, reason = await self._check_multi_session_limit(user_id, event_id)
        if not eligible:
            return PurchaseResponse(
                success=False,
                sale_mode="fanclub_presale",
                unit_price=0.0,
                total_price=0.0,
                message=reason,
            )

        # 1. Load tier with row lock
        tier = await self.tier_repo.get_for_update(tier_id)
        if not tier:
            return PurchaseResponse(
                success=False,
                sale_mode="fanclub_presale",
                unit_price=0.0,
                total_price=0.0,
                message="Tier not found",
            )

        # 1a. Validate tier belongs to the requested event
        if str(tier.event_id) != str(event_id):
            return PurchaseResponse(success=False, message="Tier does not belong to this event")

        # 🔴 숨김·비활성 티어는 이 경로로 살 수 없다 (2026-08-02).
        #    marketplace 회원 구매 경로다. 지금 KLPGA 는 `{self}` 라 여기를 안 타지만,
        #    marketplace 행사에 같은 숨김 티어(초대권 0원)가 있으면 tier_id 를 아는
        #    사람이 직접 구매로 이어갈 수 있다.
        #    ⚠️ "Tier not found" 로 통일한다 — 존재 여부를 흘리면 그 자체가 탐색 단서다.
        if str(getattr(tier, "visibility", "public")).lower() != "public" or not bool(
            getattr(tier, "is_active", True)
        ):
            return PurchaseResponse(
                success=False,
                sale_mode=getattr(tier, "sale_mode", "fixed_fcfs"),
                unit_price=0.0,
                total_price=0.0,
                message="Tier not found",
            )

        # 1b. Validate max group size
        if quantity > (tier.max_group_size or 4):
            return PurchaseResponse(success=False, message="Exceeds maximum group size")

        # 1c. Per-user purchase quantity limit (prevents split-request bypass)
        ok, msg = await self._check_per_user_quantity(user_id, tier_id, tier, quantity)
        if not ok:
            return PurchaseResponse(
                success=False,
                sale_mode="fanclub_presale",
                unit_price=tier.face_price,
                total_price=0.0,
                message=msg,
            )

        # 2. Check remaining capacity
        remaining = tier.capacity - tier.sold_count
        if remaining < quantity:
            return PurchaseResponse(
                success=False,
                sale_mode="fanclub_presale",
                unit_price=tier.face_price,
                total_price=0.0,
                message=f"Not enough seats: {remaining} remaining, {quantity} requested",
            )

        # 3. Validate
        engine_req = EnginePurchaseRequest(
            user_id=str(user_id),
            tier_id=str(tier_id),
            quantity=quantity,
        )
        engine_req.validate()

        # 3b. Verify seat holds if seat_ids provided
        if seat_ids:
            # C3: Validate seat count matches quantity
            if len(seat_ids) != quantity:
                return PurchaseResponse(
                    success=False,
                    sale_mode="fanclub_presale",
                    unit_price=tier.face_price,
                    total_price=0.0,
                    message="좌석 수와 수량이 일치하지 않습니다.",
                )
            # C2: Verify all seats belong to the correct tier
            for sid in seat_ids:
                seat = await self.seat_repo.get(sid)
                if not seat or seat.tier_id != tier_id:
                    return PurchaseResponse(
                        success=False,
                        sale_mode="fanclub_presale",
                        unit_price=tier.face_price,
                        total_price=0.0,
                        message="좌석이 해당 등급에 속하지 않습니다.",
                    )
            if not await self.seat_repo.verify_and_mark_sold(seat_ids, user_id):
                return PurchaseResponse(
                    success=False,
                    sale_mode="fanclub_presale",
                    unit_price=tier.face_price,
                    total_price=0.0,
                    message="Seat holds invalid or expired. Please re-select seats.",
                )

        # 4. Apply fanclub discount (Decimal — float 누적 오차 방지)
        discount_pct = Decimal(str(tier.fanclub_discount_pct or 0))
        unit_price = (
            Decimal(str(tier.face_price)) * (Decimal("1") - discount_pct / Decimal("100"))
        ).quantize(Decimal("0.01"))
        total_price = unit_price * quantity

        # 5. Create Order
        order = await self.order_service.create_order(
            user_id=user_id,
            event_id=event_id,
            order_data=OrderCreate(
                tier_id=tier_id,
                quantity=quantity,
                time_slot_start=time_slot_start,
                time_slot_end=time_slot_end,
            ),
            unit_price=unit_price,
            total_amount=total_price,
            order_type=OrderType.PURCHASE,
            payment_deadline=datetime.now(timezone.utc)
            + timedelta(minutes=settings.PAYMENT_EXPIRY_MINUTES),
        )

        # 6. Create Tickets (batch), linking seat_ids if provided
        tickets_data = []
        for i in range(quantity):
            ticket_data = {
                "event_id": event_id,
                "tier_id": tier_id,
                "original_owner_id": user_id,
                "current_owner_id": user_id,
                "purchase_price": unit_price,
                "sale_mode": "fanclub_presale",
                "purchase_order_id": order.id,
                "status": TicketStatus.PENDING,
                "is_resalable": tier.resale_allowed,
                "resale_max_price": tier.resale_max_price,
            }
            if seat_ids and i < len(seat_ids):
                ticket_data["seat_id"] = seat_ids[i]
            tickets_data.append(ticket_data)
        tickets = await self.ticket_repo.create_batch(tickets_data)

        # 7. Record primary sale transfers
        for ticket in tickets:
            transfer = OwnershipTransfer(
                ticket_id=ticket.id,
                from_user_id=None,
                to_user_id=user_id,
                transfer_type=TransferType.PRIMARY_SALE,
                price=unit_price,
                seller_amount=0.0,
                platform_fee=0.0,
                artist_royalty=0.0,
            )
            self.session.add(transfer)

        # 8. sold_count 관리 — PostgreSQL: trigger 자동 증가. SQLite(테스트): 수동 증가.
        import os
        if os.environ.get("PYTEST_CURRENT_TEST"):
            tier.sold_count = (tier.sold_count or 0) + quantity
            await self.session.flush()

        # 9. Audit log
        await write_audit_log(
            self.session,
            actor_id=user_id,
            action="purchase_fanclub",
            resource_type="order",
            resource_id=str(order.id),
            event_id=event_id,
            tier_id=tier_id,
            sale_mode="fanclub_presale",
            new_value={
                "quantity": quantity,
                "unit_price": unit_price,
                "total_price": total_price,
                "discount_pct": discount_pct,
                "order_id": str(order.id),
                "result": "success",
            },
        )

        # 10. Return response
        return PurchaseResponse(
            success=True,
            order_id=order.id,
            ticket_ids=[t.id for t in tickets],
            sale_mode="fanclub_presale",
            unit_price=unit_price,
            total_price=total_price,
            message=f"Fanclub order created. {quantity} ticket(s) reserved with {discount_pct}% discount. Please complete payment.",
        )


# ---------------------------------------------------------------------------
# Standalone async functions for SQS consumer
# ---------------------------------------------------------------------------


def _resolve_hold_pricing(
    tier: SeatTier, quantity: int, amount: float
) -> tuple[Decimal, Decimal, str]:
    unit_price = Decimal(str(tier.face_price or tier.base_price or 0))
    expected_total = unit_price * quantity
    if amount and amount > 0:
        amount_dec = Decimal(str(amount))
        if abs(amount_dec - expected_total) > Decimal("0.01"):
            logger.warning(
                "persist_order_from_hold: amount mismatch for tier %s, expected %s got %s; using catalog price",
                tier.id,
                expected_total,
                amount_dec,
            )
        else:
            return unit_price, amount_dec, "event_amount"
    return unit_price, expected_total, "catalog_fallback"


async def persist_order_from_hold(
    order_id: str,
    event_id: str,
    user_id: str,
    tier_id: str,
    quantity: int = 1,
    amount: float = 0,
    seat_id: str | None = None,
) -> None:
    """Create an Order row from a Go Redis-only hold arriving via SQS.

    The Go ticket-gateway creates a transient hold in Redis. This function
    persists it to PostgreSQL so the Python side has a durable record.

    Idempotent: if an order with the same ID already exists, the insert is
    skipped.

    Args:
        order_id: Order UUID string (generated by Go gateway).
        event_id: Event UUID string.
        user_id: User UUID string.
        tier_id: SeatTier UUID string.
        quantity: Number of tickets.
        amount: Total order amount.
    """
    from app.core.database import async_session

    order_uuid = uuid.UUID(order_id)
    event_uuid = uuid.UUID(event_id)
    user_uuid = uuid.UUID(user_id)
    tier_uuid = uuid.UUID(tier_id)

    quantity = max(1, quantity)
    seat_uuid = uuid.UUID(seat_id) if seat_id else None
    if seat_uuid and quantity != 1:
        raise ValueError("seat-based cart confirmation must use quantity=1")

    async with async_session() as session:
        async with session.begin():
            # Idempotency check
            existing = await session.execute(
                select(Order).where(Order.id == order_uuid)
            )
            if existing.scalar_one_or_none():
                logger.info("Order already exists, skipping: %s", order_id)
                return

            tier_result = await session.execute(
                select(SeatTier).where(
                    SeatTier.id == tier_uuid,
                    SeatTier.event_id == event_uuid,
                )
            )
            tier = tier_result.scalar_one_or_none()
            if not tier:
                raise ValueError(f"SeatTier not found for hold: {tier_id}")

            unit_price, total_amount, pricing_source = _resolve_hold_pricing(tier, quantity, amount)

            order = Order(
                id=order_uuid,
                user_id=user_uuid,
                event_id=event_uuid,
                tier_id=tier_uuid,
                order_type=OrderType.PURCHASE,
                status=OrderStatus.PAYMENT_REQUIRED,
                quantity=quantity,
                unit_price=unit_price,
                total_amount=total_amount,
                payment_deadline=datetime.now(timezone.utc)
                + timedelta(minutes=settings.PAYMENT_EXPIRY_MINUTES),
                payment_metadata={
                    "source": "ticket_gateway_cart",
                    "pricing_source": pricing_source,
                    "requested_amount": amount,
                    "catalog_unit_price": float(unit_price),
                    "catalog_total_amount": float(total_amount),
                    "seat_id": seat_id,
                },
            )
            session.add(order)

            if seat_uuid:
                seat_repo = SeatRepository(session)
                await seat_repo.mark_sold([seat_uuid])

            ticket_repo = TicketRepository(session)
            tickets_data = []
            for index in range(quantity):
                ticket_data = {
                    "event_id": event_uuid,
                    "tier_id": tier_uuid,
                    "original_owner_id": user_uuid,
                    "current_owner_id": user_uuid,
                    "purchase_price": unit_price,
                    "sale_mode": tier.sale_mode or "fixed_fcfs",
                    "purchase_order_id": order_uuid,
                    "status": TicketStatus.PENDING,
                    "is_resalable": tier.resale_allowed,
                    "resale_max_price": tier.resale_max_price,
                }
                if seat_uuid and index == 0:
                    ticket_data["seat_id"] = seat_uuid
                tickets_data.append(ticket_data)

            tickets = await ticket_repo.create_batch(tickets_data)
            for ticket in tickets:
                session.add(
                    OwnershipTransfer(
                        ticket_id=ticket.id,
                        from_user_id=None,
                        to_user_id=user_uuid,
                        transfer_type=TransferType.PRIMARY_SALE,
                        price=unit_price,
                        seller_amount=0.0,
                        platform_fee=0.0,
                        artist_royalty=0.0,
                    )
                )

            # sold_count: PostgreSQL 에서는 trg_sync_sold_count 가 ticket INSERT 시
            # 자동 증가하므로 수동 변경하면 이중 반영됨. SQLite(테스트)만 수동 관리.
            import os
            if os.environ.get("PYTEST_CURRENT_TEST") and tier:
                tier.sold_count = (tier.sold_count or 0) + quantity

    logger.info(
        "Order persisted from hold: order=%s event=%s user=%s total=%s",
        order_id, event_id, user_id, total_amount,
    )


async def finalize_payment(
    order_id: str,
    amount: float,
    currency: str = "KRW",
) -> None:
    """Mark an order as PAID and activate its tickets.

    Called when the Go gateway confirms payment via SQS. Updates the order
    status and flips all associated tickets from PENDING to ACTIVE.

    Args:
        order_id: Order UUID string.
        amount: Confirmed payment amount (for verification logging).
        currency: Payment currency code.
    """
    from app.core.database import async_session

    order_uuid = uuid.UUID(order_id)
    activated_tickets: list[tuple[str, str, str]] = []

    async with async_session() as session:
        async with session.begin():
            order_result = await session.execute(
                select(Order).where(Order.id == order_uuid).with_for_update()
            )
            order = order_result.scalar_one_or_none()
            if not order:
                logger.warning("finalize_payment: order missing: %s", order_id)
                return

            if amount and abs(Decimal(str(order.total_amount)) - Decimal(str(amount))) > Decimal("0.01"):
                logger.error(
                    "finalize_payment: AMOUNT MISMATCH — rejecting order %s (db=%.2f gateway=%.2f)",
                    order_id,
                    float(order.total_amount),
                    amount,
                )
                # 금액 불일치 시 자동 확정하지 않음 — 수동 검토 필요
                await session.execute(
                    update(Order)
                    .where(Order.id == order_uuid)
                    .values(
                        payment_failed_reason=f"AMOUNT_MISMATCH: db={float(order.total_amount):.2f} gateway={amount:.2f}",
                    )
                )
                try:
                    from app.core.alerting import send_ops_alert
                    await send_ops_alert(
                        "critical",
                        f"결제 금액 불일치: 주문 {order_id} (DB={float(order.total_amount):.2f}, 게이트웨이={amount:.2f})",
                    )
                except Exception:
                    pass
                return

            # Update order status to PAID
            result = await session.execute(
                update(Order)
                .where(
                    Order.id == order_uuid,
                    Order.status.in_([
                        OrderStatus.PAYMENT_REQUIRED,
                        OrderStatus.AUTHORIZED,
                        OrderStatus.PENDING,
                    ]),
                )
                .values(
                    status=OrderStatus.PAID,
                    payment_currency=currency,
                    captured_at=datetime.now(timezone.utc),
                )
            )

            if not result.rowcount:
                logger.warning(
                    "finalize_payment: order not updated (already paid or missing): %s",
                    order_id,
                )
                return

            ticket_result = await session.execute(
                select(Ticket).where(
                    Ticket.purchase_order_id == order_uuid,
                    Ticket.status == TicketStatus.PENDING,
                )
            )
            tickets = list(ticket_result.scalars().all())
            if not tickets:
                logger.warning(
                    "finalize_payment: no pending tickets found for order %s",
                    order_id,
                )
            for ticket in tickets:
                activated_tickets.append(
                    (str(ticket.id), str(ticket.event_id), str(ticket.current_owner_id))
                )

            await session.execute(
                update(Ticket)
                .where(
                    Ticket.purchase_order_id == order_uuid,
                    Ticket.status == TicketStatus.PENDING,
                )
                .values(status=TicketStatus.ACTIVE)
            )

    if activated_tickets:
        from app.services.notification_service import send_ticket_notification

        for ticket_id, event_id, user_id in activated_tickets:
            await send_ticket_notification(
                ticket_id=ticket_id,
                event_id=event_id,
                user_id=user_id,
            )

    logger.info(
        "Payment finalized: order=%s amount=%s %s tickets=%d",
        order_id, amount, currency, len(activated_tickets),
    )
