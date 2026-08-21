"""
Waitlist Service
=================
Manages priority-ordered waitlists for sold-out tiers.

P3 Face-Value Waitlist (FEATURE_FACE_VALUE_WAITLIST):
  - 취소 발생 시 priority_score 최상위에게 10분 오퍼
  - 타임아웃 → 다음 대기자 이관
  - 액면가 재배정 (수수료 가산 금지)
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

from talkfile_engine.audit_log import AuditLog as EngineAuditLog
from talkfile_engine.notifications import NotificationService as EngineNotificationService
from talkfile_engine.orchestrator import ModeRouter
from talkfile_engine.waitlist import (
    Waitlist as EngineWaitlist,
    WaitlistEntry as EngineWaitlistEntry,
)

from app.models.waitlist import WaitlistEntryModel, WaitlistStatus
from app.models.notification import NotificationModel
from app.core.audit import write_audit_log
from app.repositories.waitlist_repo import WaitlistRepository
from app.schemas.waitlist import WaitlistEntryResponse, WaitlistStatusResponse


class WaitlistService:
    """Service for managing ticket waitlists."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.waitlist_repo = WaitlistRepository(session)

    async def add(
        self,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
        priority_score: float,
        quantity: int = 1,
        group_id: uuid.UUID | None = None,
        group_size: int = 1,
    ) -> WaitlistEntryResponse:
        """
        Add a user to the waitlist for a tier.

        Args:
            user_id: User's UUID.
            event_id: Event UUID.
            tier_id: Seat tier UUID.
            priority_score: Priority for ordering (higher = better position).
            quantity: Number of seats needed.
            group_id: Optional group identifier.
            group_size: Size of the group.

        Returns:
            WaitlistEntryResponse with entry details.

        Raises:
            ValueError: If user is already on the waitlist for this tier.
        """
        # Check for duplicate
        existing = await self.waitlist_repo.get_user_entry(tier_id, user_id)
        if existing:
            raise ValueError("User is already on the waitlist for this tier")

        # Create waitlist entry
        entry = await self.waitlist_repo.create(
            event_id=event_id,
            tier_id=tier_id,
            user_id=user_id,
            priority_score=priority_score,
            group_id=group_id,
            group_size=group_size,
            quantity=quantity,
            status=WaitlistStatus.WAITING,
        )

        # Get position
        position = await self.waitlist_repo.get_position(tier_id, priority_score)

        # Audit
        await write_audit_log(
            self.session,
            actor_id=user_id,
            action="waitlist_join",
            resource_type="waitlist",
            resource_id=str(entry.id),
            event_id=event_id,
            tier_id=tier_id,
            new_value={
                "priority_score": priority_score,
                "position": position,
                "quantity": quantity,
                "group_id": str(group_id) if group_id else None,
                "result": "success",
            },
        )

        return WaitlistEntryResponse(
            id=entry.id,
            tier_id=tier_id,
            user_id=user_id,
            position=position,
            priority_score=priority_score,
            status=entry.status.value,
            entered_at=entry.entered_at,
        )

    async def remove(self, user_id: uuid.UUID, tier_id: uuid.UUID) -> None:
        """
        Remove a user from the waitlist.

        Args:
            user_id: User's UUID.
            tier_id: Seat tier UUID.

        Raises:
            ValueError: If entry not found.
        """
        entry = await self.waitlist_repo.get_user_entry(tier_id, user_id)
        if not entry:
            raise ValueError("Waitlist entry not found")

        entry.status = WaitlistStatus.REMOVED
        await self.session.flush()

    async def get_status(
        self,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
    ) -> WaitlistStatusResponse:
        """
        Get waitlist status for a user and tier.

        Args:
            user_id: User's UUID.
            event_id: Event UUID.
            tier_id: Seat tier UUID.

        Returns:
            WaitlistStatusResponse with position and total waiting count.
        """
        total_waiting = await self.waitlist_repo.count_waiting(tier_id)

        entry = await self.waitlist_repo.get_user_entry(tier_id, user_id)
        if not entry:
            return WaitlistStatusResponse(
                total_waiting=total_waiting,
                my_position=None,
                my_entry=None,
            )

        position = await self.waitlist_repo.get_position(tier_id, entry.priority_score)

        my_entry = WaitlistEntryResponse(
            id=entry.id,
            tier_id=tier_id,
            user_id=user_id,
            position=position,
            priority_score=entry.priority_score,
            status=entry.status.value,
            entered_at=entry.entered_at,
        )

        return WaitlistStatusResponse(
            total_waiting=total_waiting,
            my_position=position,
            my_entry=my_entry,
        )

    async def reallocate_next(
        self,
        tier_id: uuid.UUID,
        available_seats: int,
        event_id: uuid.UUID | None = None,
        cancelled_by: str = "",
        price: float = 0.0,
        deadline_minutes: int = 30,
    ) -> list[dict]:
        """
        Offer available seats to the next users on the waitlist.

        Uses engine ModeRouter.process_cancellation_with_notification() to
        handle cancellation reallocation with proper notifications. Falls
        back to basic reallocation if engine setup fails.

        Args:
            tier_id: Seat tier UUID.
            available_seats: Number of seats now available.
            event_id: Optional event UUID for engine notification integration.
            cancelled_by: User ID who cancelled (for audit trail).
            price: Price to charge reallocated users.
            deadline_minutes: Payment deadline in minutes.

        Returns:
            List of dicts with user_id, quantity for each offered user.
        """
        if available_seats <= 0:
            return []

        # Get waitlist entries ordered by priority (highest first)
        entries = await self.waitlist_repo.get_by_tier_ordered(tier_id)
        if not entries:
            return []

        # Use engine ModeRouter for cancellation with notification
        if event_id:
            engine_audit = EngineAuditLog()
            engine_waitlist = EngineWaitlist()
            engine_notifications = EngineNotificationService()

            # Populate engine waitlist from DB entries
            for entry in entries:
                engine_waitlist.add(
                    EngineWaitlistEntry(
                        user_id=str(entry.user_id),
                        tier_id=str(tier_id),
                        priority_score=entry.priority_score,
                        group_id=str(entry.group_id) if entry.group_id else None,
                        group_size=entry.group_size,
                        quantity=entry.quantity,
                    )
                )

            mode_router = ModeRouter(
                audit_log=engine_audit,
                waitlist=engine_waitlist,
                notifications=engine_notifications,
            )
            mode_router._event_id = str(event_id)

            reallocation_results = mode_router.process_cancellation_with_notification(
                tier_id=str(tier_id),
                freed_seats=available_seats,
                cancelled_by=cancelled_by,
                price=price,
                deadline_minutes=deadline_minutes,
            )

            # Map engine results back to DB updates
            offered = []
            reallocated_user_ids = {r.user_id for r in reallocation_results}

            for entry in entries:
                if str(entry.user_id) in reallocated_user_ids:
                    entry.status = WaitlistStatus.OFFERED
                    offered.append(
                        {
                            "user_id": entry.user_id,
                            "entry_id": entry.id,
                            "quantity": entry.quantity,
                            "priority_score": entry.priority_score,
                        }
                    )

                    # Create DB notification for each reallocated user
                    notification = NotificationModel(
                        user_id=entry.user_id,
                        event_id=event_id,
                        tier_id=tier_id,
                        type="cancellation_offer",
                        message=f"A seat is available at {price:,.0f}! You have {deadline_minutes} minutes to pay.",
                        data={
                            "price": price,
                            "deadline_minutes": deadline_minutes,
                            "cancelled_by": cancelled_by,
                        },
                    )
                    self.session.add(notification)

            await self.session.flush()
            return offered

        # Fallback: basic reallocation without engine notifications
        offered = []
        remaining_seats = available_seats

        for entry in entries:
            if remaining_seats <= 0:
                break

            if entry.quantity <= remaining_seats:
                entry.status = WaitlistStatus.OFFERED
                offered.append(
                    {
                        "user_id": entry.user_id,
                        "entry_id": entry.id,
                        "quantity": entry.quantity,
                        "priority_score": entry.priority_score,
                    }
                )
                remaining_seats -= entry.quantity

        await self.session.flush()
        return offered

    async def accept_offer(self, user_id: uuid.UUID, tier_id: uuid.UUID) -> None:
        """
        Mark a waitlist offer as accepted.

        Args:
            user_id: User's UUID.
            tier_id: Seat tier UUID.

        Raises:
            ValueError: If no offered entry found.
        """
        from sqlalchemy import select

        result = await self.session.execute(
            select(WaitlistEntryModel).where(
                WaitlistEntryModel.tier_id == tier_id,
                WaitlistEntryModel.user_id == user_id,
                WaitlistEntryModel.status == WaitlistStatus.OFFERED,
            )
        )
        entry = result.scalar_one_or_none()
        if not entry:
            raise ValueError("No offered waitlist entry found")

        entry.status = WaitlistStatus.ACCEPTED
        await self.session.flush()

    async def expire_offers(self, tier_id: uuid.UUID) -> int:
        """
        Expire all OFFERED entries that haven't been accepted.

        Returns:
            Number of entries expired.
        """
        from sqlalchemy import select

        result = await self.session.execute(
            select(WaitlistEntryModel).where(
                WaitlistEntryModel.tier_id == tier_id,
                WaitlistEntryModel.status == WaitlistStatus.OFFERED,
            )
        )
        entries = list(result.scalars().all())

        for entry in entries:
            entry.status = WaitlistStatus.EXPIRED

        await self.session.flush()
        return len(entries)

    # ── P3 Face-Value Waitlist 확장 ──────────────────────────────────────

    async def offer_face_value(
        self,
        tier_id: uuid.UUID,
        event_id: uuid.UUID,
        face_price: float,
        offer_minutes: int = 10,
    ) -> dict | None:
        """취소 발생 시 최상위 대기자에게 액면가 오퍼 (10분 제한).

        Args:
            tier_id: 등급 UUID.
            event_id: 이벤트 UUID.
            face_price: 액면가 (수수료 가산 금지).
            offer_minutes: 오퍼 유효 시간 (기본 10분).

        Returns:
            오퍼된 사용자 정보 dict, 또는 대기자 없으면 None.
        """
        # 최상위 1명 (priority_score DESC)
        entries = await self.waitlist_repo.get_by_tier_ordered(tier_id)
        if not entries:
            return None

        top_entry = entries[0]

        # 액면가 assertion (수수료 가산 금지)
        assert face_price > 0, "face_price must be positive"

        top_entry.status = WaitlistStatus.OFFERED
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=offer_minutes)

        # 오퍼 알림
        notification = NotificationModel(
            user_id=top_entry.user_id,
            event_id=event_id,
            tier_id=tier_id,
            type="WAITLIST_OFFERED",
            message=f"취소표가 발생했습니다! {face_price:,.0f}원에 구매할 수 있어요. {offer_minutes}분 안에 결제하세요.",
            data={
                "price": face_price,
                "enforced_face_value": True,
                "offer_minutes": offer_minutes,
                "expires_at": expires_at.isoformat(),
                "entry_id": str(top_entry.id),
            },
        )
        self.session.add(notification)
        await self.session.flush()

        logger.info(
            "face_value_offer tier=%s user=%s price=%s expires=%s",
            tier_id, top_entry.user_id, face_price, expires_at,
        )

        return {
            "user_id": top_entry.user_id,
            "entry_id": top_entry.id,
            "face_price": face_price,
            "expires_at": expires_at,
        }

    async def expire_and_transfer(
        self,
        tier_id: uuid.UUID,
        event_id: uuid.UUID,
        face_price: float,
        offer_minutes: int = 10,
    ) -> dict | None:
        """타임아웃된 오퍼를 만료시키고 다음 대기자에게 이관.

        Returns:
            새 오퍼 정보 또는 None.
        """
        # 만료 처리: OFFERED → EXPIRED
        result = await self.session.execute(
            select(WaitlistEntryModel).where(
                WaitlistEntryModel.tier_id == tier_id,
                WaitlistEntryModel.status == WaitlistStatus.OFFERED,
            )
        )
        offered_entries = list(result.scalars().all())

        expired_count = 0
        for entry in offered_entries:
            entry.status = WaitlistStatus.EXPIRED
            expired_count += 1

            # 만료 알림
            notification = NotificationModel(
                user_id=entry.user_id,
                event_id=event_id,
                tier_id=tier_id,
                type="WAITLIST_EXPIRED",
                message="오퍼 시간이 만료되었습니다. 다음 대기자에게 기회가 넘어갑니다.",
                data={"entry_id": str(entry.id)},
            )
            self.session.add(notification)

        if expired_count > 0:
            await self.session.flush()
            logger.info(
                "face_value_expired tier=%s count=%d", tier_id, expired_count,
            )

        # 다음 대기자에게 오퍼
        return await self.offer_face_value(
            tier_id=tier_id,
            event_id=event_id,
            face_price=face_price,
            offer_minutes=offer_minutes,
        )
