"""Notification 도메인 저장소(DAO).

DB 액세스 계층 — SQLAlchemy 쿼리/저장 캡슐화. 비즈니스 규칙 금지.
"""
import uuid

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import NotificationModel, PriceAlertModel
from app.shared.repository import BaseRepository


class NotificationRepository(BaseRepository[NotificationModel]):
    """알림 ORM 쿼리 모음."""

    def __init__(self, session: AsyncSession):
        super().__init__(NotificationModel, session)

    async def get_by_user(
        self,
        user_id: uuid.UUID,
        *,
        unread_only: bool = False,
        skip: int = 0,
        limit: int = 50,
    ) -> list[NotificationModel]:
        """사용자별 알림 최신순. unread_only 필터 + 페이지네이션."""
        stmt = select(NotificationModel).where(NotificationModel.user_id == user_id)
        if unread_only:
            stmt = stmt.where(NotificationModel.is_read.is_(False))
        stmt = stmt.order_by(NotificationModel.created_at.desc()).offset(skip).limit(limit)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def count_unread(self, user_id: uuid.UUID) -> int:
        """사용자의 미읽음 알림 개수."""
        result = await self.session.execute(
            select(func.count(NotificationModel.id)).where(
                NotificationModel.user_id == user_id,
                NotificationModel.is_read.is_(False),
            )
        )
        return result.scalar() or 0

    async def mark_read(self, notification_id: uuid.UUID) -> None:
        """단건 읽음 (소유자 검증 없음 — 내부 호출용)."""
        notif = await self.get(notification_id)
        if notif:
            notif.is_read = True
            await self.session.flush()

    async def mark_read_for_user(
        self, notification_id: uuid.UUID, user_id: uuid.UUID
    ) -> bool:
        """소유자가 본인 알림 읽음 처리. 권한 없음 → False."""
        notif = await self.get(notification_id)
        # 상세통합 S1(§7.3): 게스트 통지는 user_id NULL(guest_id 로 발행)이므로, 회원 소유검증에서
        # user_id is None 을 명시적으로 배제한다(게스트 통지가 회원 read 경로로 새지 않도록 방어).
        if not notif or notif.user_id is None or notif.user_id != user_id:
            return False
        notif.is_read = True
        await self.session.flush()
        return True

    async def update_read_for_user(
        self, notification_id: uuid.UUID, user_id: uuid.UUID
    ) -> int:
        """단건 읽음 UPDATE — 소유자 검증 포함. rowcount 반환."""
        result = await self.session.execute(
            update(NotificationModel)
            .where(
                NotificationModel.id == notification_id,
                NotificationModel.user_id == user_id,
            )
            .values(is_read=True)
            .execution_options(synchronize_session="fetch")
        )
        await self.session.flush()
        return int(result.rowcount or 0)

    async def update_all_read_for_user(self, user_id: uuid.UUID) -> int:
        """사용자의 모든 미읽음 일괄 읽음. rowcount 반환."""
        result = await self.session.execute(
            update(NotificationModel)
            .where(
                NotificationModel.user_id == user_id,
                NotificationModel.is_read.is_(False),
            )
            .values(is_read=True)
            .execution_options(synchronize_session="fetch")
        )
        await self.session.flush()
        return int(result.rowcount or 0)

    async def get_unsent(self, limit: int = 100) -> list[NotificationModel]:
        """미발송 알림 — Celery 워커가 SSE/푸시 처리할 대상."""
        result = await self.session.execute(
            select(NotificationModel)
            .where(NotificationModel.is_sent.is_(False))
            .order_by(NotificationModel.created_at.asc())
            .limit(limit)
        )
        return list(result.scalars().all())

    async def list_bid_user_ids_for_event(
        self, event_id: uuid.UUID
    ) -> set[uuid.UUID]:
        """특정 이벤트에 입찰한 사용자 ID 집합 — 캐스팅 변경 알림 대상.

        주: bid 도메인 미이관 — repository 가 임시로 다른 도메인 모델 lazy import.
        Phase 5 에서 EventBus 패턴으로 분리 예정.
        """
        from app.models.bid import Bid

        result = await self.session.execute(
            select(Bid.user_id).where(Bid.event_id == event_id).distinct()
        )
        return {row[0] for row in result.fetchall()}

    async def list_order_user_ids_for_event(
        self, event_id: uuid.UUID
    ) -> set[uuid.UUID]:
        """특정 이벤트의 주문자 ID 집합 — 캐스팅 변경 알림 대상."""
        from app.models.order import Order

        result = await self.session.execute(
            select(Order.user_id).where(Order.event_id == event_id).distinct()
        )
        return {row[0] for row in result.fetchall()}


class PriceAlertRepository(BaseRepository[PriceAlertModel]):
    """더치 옥션 가격 알림 저장소."""

    def __init__(self, session: AsyncSession):
        super().__init__(PriceAlertModel, session)

    async def get_untriggered_by_tier(self, tier_id: uuid.UUID) -> list[PriceAlertModel]:
        """특정 tier 의 미트리거 알림 목록 — 가격 변동 시 일괄 검사."""
        result = await self.session.execute(
            select(PriceAlertModel).where(
                PriceAlertModel.tier_id == tier_id,
                PriceAlertModel.triggered.is_(False),
            )
        )
        return list(result.scalars().all())
