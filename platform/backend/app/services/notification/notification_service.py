"""Notification 도메인 서비스.

비즈니스 로직 계층 — 트랜잭션 경계, 도메인 규칙, 외부 시스템 호출.
repository 를 통해서만 DB 에 접근하고, 다른 도메인은 service 경유로만 호출.

엔트리포인트:
    - NotificationService.notify(): 일반 알림 발행 (+ SSE 즉시 푸시)
    - NotificationService.get_notifications(): 페이지네이션 조회
    - send_ticket_notification(): SQS consumer 용 standalone 함수
"""
import json
import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import NotificationModel
from app.repositories.notification.notification_repo import (
    NotificationRepository,
    PriceAlertRepository,
)
from app.schemas.notification.notification_responses import (
    NotificationListResponse,
    NotificationResponse,
)
from app.shared.service import BaseService

logger = logging.getLogger(__name__)


async def send_ticket_notification(
    ticket_id: str,
    event_id: str,
    user_id: str,
) -> None:
    """TICKET_ISSUED 알림 생성 + Redis SSE 발행.

    SQS consumer 가 호출 — Go gateway 가 티켓을 발급할 때 큐 메시지 처리.
    자체 DB 세션 생성 (의존성 주입 아님).

    Args:
        ticket_id: 티켓 UUID 문자열.
        event_id: 이벤트 UUID 문자열.
        user_id: 사용자 UUID 문자열.
    """
    from app.core.database import async_session

    user_uuid = uuid.UUID(user_id)
    event_uuid = uuid.UUID(event_id)

    async with async_session() as session:
        async with session.begin():
            svc = NotificationService(session)
            await svc.notify(
                user_id=user_uuid,
                event_id=event_uuid,
                type="TICKET_ISSUED",
                message="티켓이 발급되었습니다.",
                data={"ticket_id": ticket_id},
            )

    logger.info(
        "Ticket notification sent: ticket=%s user=%s event=%s",
        ticket_id, user_id, event_id,
    )


class NotificationService(BaseService):
    """알림 도메인 비즈니스 로직 — DB 영속화 + SSE 발행."""

    def __init__(self, session: AsyncSession):
        super().__init__(session)
        self.notification_repo = NotificationRepository(session)
        self.price_alert_repo = PriceAlertRepository(session)

    async def get_user_notifications(
        self,
        user_id: uuid.UUID,
        *,
        unread_only: bool = False,
        skip: int = 0,
        limit: int = 50,
    ) -> list[NotificationModel]:
        """사용자별 알림 ORM 객체 반환 — 최신순."""
        return await self.notification_repo.get_by_user(
            user_id, unread_only=unread_only, skip=skip, limit=limit
        )

    async def get_unread_count(self, user_id: uuid.UUID) -> int:
        """미읽음 알림 수."""
        return int(await self.notification_repo.count_unread(user_id))

    async def mark_as_read(self, notification_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        """단건 읽음 — 소유자 검증 포함. 미존재/권한 없음 → False."""
        rowcount = await self.notification_repo.update_read_for_user(
            notification_id, user_id
        )
        return rowcount > 0

    async def mark_all_as_read(self, user_id: uuid.UUID) -> int:
        """사용자의 모든 미읽음 알림 일괄 읽음 처리. 반환값=처리 건수."""
        return await self.notification_repo.update_all_read_for_user(user_id)

    async def create_notification(
        self,
        user_id: uuid.UUID,
        *,
        type: str,
        message: str,
        event_id: uuid.UUID | None = None,
        tier_id: uuid.UUID | None = None,
        data: dict | None = None,
    ) -> NotificationModel:
        """알림 row 생성만 (SSE 발행 없음). 내부 호출용."""
        notif = NotificationModel(
            user_id=user_id,
            event_id=event_id,
            tier_id=tier_id,
            type=type,
            message=message,
            data=data,
            is_read=False,
            is_sent=False,
        )
        self.session.add(notif)
        await self.session.flush()
        return notif

    async def notify(
        self,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        type: str,
        message: str,
        data: dict | None = None,
        tier_id: uuid.UUID | None = None,
    ) -> uuid.UUID:
        """알림 영속화 + Redis SSE 채널 즉시 푸시.

        다른 도메인(결제·티켓·추첨 등)이 사용자에게 알림 보낼 때의 표준 엔트리포인트.
        SSE publish 실패는 비치명적 — DB 에 남아있어 폴링/재시도로 복구.

        Args:
            user_id: 대상 사용자 UUID.
            event_id: 연관 이벤트 UUID.
            type: 알림 타입 ("BID_CONFIRMED", "ALLOCATION_RESULT" 등).
            message: 사용자 표시용 한국어 메시지.
            data: 구조화된 추가 페이로드.
            tier_id: 좌석 등급 컨텍스트 (옵션).

        Returns:
            생성된 알림 UUID.
        """
        notification = await self.notification_repo.create(
            user_id=user_id,
            event_id=event_id,
            tier_id=tier_id,
            type=type,
            message=message,
            data=data,
            is_read=False,
            is_sent=False,
        )

        try:
            await self.publish_sse(
                user_id=user_id,
                data={
                    "type": type,
                    "notification_id": str(notification.id),
                    "message": message,
                    "event_id": str(event_id),
                    "tier_id": str(tier_id) if tier_id else None,
                    "data": data,
                },
            )
            notification.is_sent = True
        except Exception:
            logger.warning(
                "Failed to publish SSE notification for user %s: %s",
                user_id, type,
                exc_info=True,
            )

        await self.session.flush()
        return notification.id

    async def get_notifications(
        self,
        user_id: uuid.UUID,
        unread_only: bool = False,
        skip: int = 0,
        limit: int = 50,
    ) -> NotificationListResponse:
        """페이지네이션 알림 목록 + 미읽음 수 반환 (라우터 응답용)."""
        notifications = await self.get_user_notifications(
            user_id=user_id,
            unread_only=unread_only,
            skip=skip,
            limit=limit,
        )
        unread_count = await self.get_unread_count(user_id)

        return NotificationListResponse(
            notifications=[
                NotificationResponse(
                    id=n.id,
                    type=n.type,
                    message=n.message,
                    data=n.data,
                    is_read=n.is_read,
                    created_at=n.created_at,
                )
                for n in notifications
            ],
            unread_count=unread_count,
        )

    async def mark_read(self, notification_id: uuid.UUID) -> None:
        """단건 읽음 (소유자 검증 없음 — 내부 호출용)."""
        await self.notification_repo.mark_read(notification_id)

    async def mark_read_for_user(
        self,
        notification_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> bool:
        """단건 읽음 (소유자 검증 포함)."""
        return await self.mark_as_read(notification_id, user_id)

    async def mark_all_read(self, user_id: uuid.UUID) -> int:
        """모든 미읽음 알림 일괄 읽음."""
        return await self.mark_all_as_read(user_id)

    async def publish_sse(self, user_id: uuid.UUID, data: dict) -> None:
        """알림 이벤트를 Redis pub/sub 으로 발행 (SSE 스트림 구독).

        채널: sse:user:{user_id}
        """
        from app.core.redis import get_redis

        redis = get_redis()
        channel = f"sse:user:{user_id}"
        await redis.publish(channel, json.dumps(data, default=str))

    async def notify_casting_change(
        self,
        event_id: uuid.UUID,
        old_cast: dict[str, str],
        new_cast: dict[str, str],
    ) -> int:
        """뮤지컬/클래식 이벤트 캐스팅 변경 시 입찰자/구매자 일괄 알림."""
        # 입찰자/구매자 UUID 수집 — repository 가 다른 도메인 모델을 임시 lazy import.
        # Phase 4/5 EventBus 패턴으로 전환 예정.
        bid_user_ids = await self.notification_repo.list_bid_user_ids_for_event(event_id)
        order_user_ids = await self.notification_repo.list_order_user_ids_for_event(event_id)
        all_user_ids = bid_user_ids | order_user_ids

        changes = []
        for role in set(list(old_cast.keys()) + list(new_cast.keys())):
            old_name = old_cast.get(role, "-")
            new_name = new_cast.get(role, "-")
            if old_name != new_name:
                changes.append(f"{role}: {old_name} -> {new_name}")

        if not changes:
            return 0

        change_summary = ", ".join(changes)
        message = f"캐스팅 변경 안내: {change_summary}"

        count = 0
        for uid in all_user_ids:
            try:
                await self.notify(
                    user_id=uid,
                    event_id=event_id,
                    type="CASTING_CHANGE",
                    message=message,
                    data={"old_cast": old_cast, "new_cast": new_cast},
                )
                count += 1
            except Exception:
                logger.warning(
                    "Failed to send casting change notification to user %s",
                    uid, exc_info=True,
                )

        logger.info(
            "Casting change notifications sent: event=%s count=%d",
            event_id, count,
        )
        return count

    async def subscribe_price_alert(
        self,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
        target_price: float,
    ) -> uuid.UUID:
        """더치 옥션 가격 알림 구독.

        Returns:
            생성된 PriceAlert UUID.
        """
        alert = await self.price_alert_repo.create(
            user_id=user_id,
            event_id=event_id,
            tier_id=tier_id,
            target_price=target_price,
            triggered=False,
        )
        return alert.id

    async def check_price_alerts(self, tier_id: uuid.UUID, current_price: float) -> int:
        """더치 가격이 대상가 이하로 떨어진 알림 트리거.

        Returns:
            트리거된 알림 수.
        """
        alerts = await self.price_alert_repo.get_untriggered_by_tier(tier_id)
        triggered_count = 0

        for alert in alerts:
            if current_price <= alert.target_price:
                alert.triggered = True
                triggered_count += 1

                await self.notify(
                    user_id=alert.user_id,
                    event_id=alert.event_id,
                    type="PRICE_DROP",
                    message=(
                        f"Price dropped to {current_price:,.0f} "
                        f"(your target: {alert.target_price:,.0f})"
                    ),
                    data={
                        "current_price": current_price,
                        "target_price": alert.target_price,
                    },
                    tier_id=tier_id,
                )

        await self.session.flush()
        return triggered_count
