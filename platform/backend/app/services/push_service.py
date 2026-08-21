"""
Web Push Notification Service (P1-6)
=====================================
Sends push notifications via the Web Push protocol using pywebpush.
Handles subscription management, category-based filtering,
and automatic deactivation of expired subscriptions.
"""

import asyncio
import json
import logging
import uuid
from typing import Any

import httpx
from pywebpush import webpush, WebPushException
from sqlalchemy import select, update, delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.http_client import traced_headers
from app.models.push_subscription import PushSubscription
from app.models.user import User

logger = logging.getLogger(__name__)

# Expo push endpoint (Phase E.0)
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"


def _is_expo_token(endpoint: str) -> bool:
    """Expo push token 형식 판별: ExponentPushToken[...] 또는 ExpoPushToken[...]"""
    return endpoint.startswith("ExponentPushToken[") or endpoint.startswith("ExpoPushToken[")

# Notification type → preference category mapping
NOTIFICATION_CATEGORY_MAP: dict[str, str] = {
    "ALLOCATION_RESULT": "allocation_result",
    "ALLOCATION_WIN": "allocation_result",
    "ALLOCATION_LOSE": "allocation_result",
    "BID_CONFIRMED": "allocation_result",
    "PAYMENT_REQUIRED": "payment_reminder",
    "PAYMENT_REMINDER": "payment_reminder",
    "PAYMENT_CONFIRMED": "payment_reminder",
    "EVENT_UPDATE": "event_update",
    "EVENT_CANCELLED": "event_update",
    "CASTING_CHANGE": "event_update",
    "PRICE_DROP": "price_watch",
    "PRICE_ALERT": "price_watch",
    "PRICE_WATCH": "price_watch",
    "LOW_STOCK": "price_watch",
    "TICKET_ISSUED": "event_update",
    "MARKETING": "marketing",
    # Phase E 신규 카테고리
    "LOCATION_NEARBY": "location_based",
    "WEEKLY_CURATION": "weekly_curation",
    "FRIEND_FAVORITE": "friend_activity",
    "FRIEND_ACTIVITY": "friend_activity",
    # P6: Event-Open 알림
    "EVENT_OPEN_ALERT": "event_update",
}


def _get_vapid_claims() -> dict[str, str]:
    return {"sub": f"mailto:{settings.VAPID_CONTACT_EMAIL}"}


async def subscribe(
    session: AsyncSession,
    user_id: uuid.UUID,
    endpoint: str,
    p256dh: str | None = None,
    auth: str | None = None,
    token_type: str = "vapid",
) -> PushSubscription:
    """Register or reactivate a push subscription for a user.

    Uses PostgreSQL ON CONFLICT to handle duplicate (user_id, endpoint) pairs.
    Expo 토큰 등록 시 p256dh/auth 는 None. token_type 으로 발송 경로 분기.
    """
    stmt = (
        pg_insert(PushSubscription)
        .values(
            user_id=user_id,
            endpoint=endpoint,
            p256dh=p256dh,
            auth=auth,
            token_type=token_type,
            is_active=True,
        )
        .on_conflict_do_update(
            constraint="uq_push_subscription_user_endpoint",
            set_={
                "p256dh": p256dh,
                "auth": auth,
                "token_type": token_type,
                "is_active": True,
            },
        )
        .returning(PushSubscription)
    )
    result = await session.execute(stmt)
    await session.flush()
    return result.scalar_one()


async def unsubscribe(
    session: AsyncSession,
    user_id: uuid.UUID,
    endpoint: str,
) -> bool:
    """Deactivate a push subscription."""
    result = await session.execute(
        update(PushSubscription)
        .where(
            PushSubscription.user_id == user_id,
            PushSubscription.endpoint == endpoint,
        )
        .values(is_active=False)
    )
    await session.flush()
    return (result.rowcount or 0) > 0


async def unsubscribe_all(
    session: AsyncSession,
    user_id: uuid.UUID,
) -> int:
    """Deactivate all push subscriptions for a user."""
    result = await session.execute(
        update(PushSubscription)
        .where(
            PushSubscription.user_id == user_id,
            PushSubscription.is_active.is_(True),
        )
        .values(is_active=False)
    )
    await session.flush()
    return int(result.rowcount or 0)


async def _get_active_subscriptions(
    session: AsyncSession,
    user_id: uuid.UUID,
) -> list[PushSubscription]:
    """Fetch all active subscriptions for a user."""
    result = await session.execute(
        select(PushSubscription).where(
            PushSubscription.user_id == user_id,
            PushSubscription.is_active.is_(True),
        )
    )
    return list(result.scalars().all())


def _should_send(
    notification_type: str,
    user_preferences: dict[str, Any] | None,
) -> bool:
    """Check if the notification should be sent based on user preferences.

    Returns True if:
    - push_enabled is True (default True)
    - The category for this notification type is enabled (default True)
    """
    prefs = user_preferences or {}

    # Global push toggle
    if not prefs.get("push_enabled", True):
        return False

    # Category-level toggle
    category = NOTIFICATION_CATEGORY_MAP.get(notification_type)
    if category and not prefs.get(category, True):
        return False

    return True


def _send_single_expo_push(
    endpoint: str,
    title: str,
    body: str,
    data: dict[str, Any] | None,
) -> bool:
    """Send a single push via Expo. Returns True on success, False on DeviceNotRegistered.

    endpoint 값은 ExponentPushToken[...] 또는 ExpoPushToken[...] 형식.
    """
    try:
        message = {
            "to": endpoint,
            "title": title,
            "body": body,
            "data": data or {},
            "sound": "default",
            "priority": "high",
        }
        headers = traced_headers({
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate",
            "Content-Type": "application/json",
        })
        expo_token = getattr(settings, "EXPO_ACCESS_TOKEN", None)
        if expo_token:
            headers["Authorization"] = f"Bearer {expo_token}"

        with httpx.Client(timeout=10.0) as client:
            response = client.post(EXPO_PUSH_URL, json=message, headers=headers)

        if response.status_code >= 500:
            logger.warning("Expo push server error: %s", response.status_code)
            return True  # transient — don't deactivate

        result = response.json()
        # Single message response shape: { "data": { "status": "ok"|"error", "details": {...} } }
        ticket = result.get("data") if isinstance(result, dict) else None
        if isinstance(ticket, dict) and ticket.get("status") == "error":
            details = ticket.get("details") or {}
            error_code = details.get("error") if isinstance(details, dict) else None
            if error_code in ("DeviceNotRegistered", "InvalidCredentials"):
                return False  # caller should deactivate
            logger.warning(
                "Expo push error (code=%s): %s",
                error_code,
                str(ticket.get("message"))[:200],
            )
        return True
    except Exception:
        logger.exception("Unexpected error sending Expo push")
        return True  # don't deactivate on transient errors


def _send_single_push(
    endpoint: str,
    p256dh: str | None,
    auth: str | None,
    payload: str,
    *,
    title: str = "",
    body: str = "",
    data: dict[str, Any] | None = None,
) -> bool:
    """Send a single push message. Returns True on success, False if subscription should be deactivated.

    Expo token 일 경우 Expo HTTP API 경유, VAPID 일 경우 pywebpush.
    """
    # Expo 분기 (Phase E.0)
    if _is_expo_token(endpoint):
        return _send_single_expo_push(endpoint, title, body, data)

    # VAPID 경로 (기존 웹 푸시)
    if not p256dh or not auth:
        logger.warning("VAPID subscription missing p256dh/auth — skipping")
        return True
    try:
        webpush(
            subscription_info={
                "endpoint": endpoint,
                "keys": {"p256dh": p256dh, "auth": auth},
            },
            data=payload,
            vapid_private_key=settings.VAPID_PRIVATE_KEY,
            vapid_claims=_get_vapid_claims(),
            ttl=86400,  # 24h
        )
        return True
    except WebPushException as e:
        status_code = getattr(e, "response", None)
        if status_code is not None:
            status_code = getattr(status_code, "status_code", None)
        if status_code == 410:
            # Subscription expired — caller should deactivate
            return False
        logger.warning(
            "Web Push delivery failed (status=%s): %s",
            status_code,
            str(e)[:200],
        )
        return True  # Don't deactivate on transient errors
    except Exception:
        logger.exception("Unexpected error sending Web Push")
        return True


async def _dispatch_pushes(
    subscriptions,
    payload: str,
    *,
    title: str,
    body: str,
    data: dict[str, Any] | None,
    category: str | None,
) -> tuple[int, list[uuid.UUID]]:
    """Send to all subscriptions concurrently, off the event loop.

    ``_send_single_push`` does blocking network I/O (sync httpx / pywebpush);
    running it inline in an async handler would block the event loop and
    serialize every device. Fan out via ``asyncio.to_thread`` + ``gather`` so
    the loop stays responsive and sends run in parallel.

    Returns ``(sent_count, expired_subscription_ids)``.
    """
    payload_data = (
        {**(data or {}), "category": category} if category else (data or {})
    )
    results = await asyncio.gather(
        *[
            asyncio.to_thread(
                _send_single_push,
                sub.endpoint,
                sub.p256dh,
                sub.auth,
                payload,
                title=title,
                body=body,
                data=payload_data,
            )
            for sub in subscriptions
        ]
    )
    sent_count = 0
    expired_ids: list[uuid.UUID] = []
    for sub, success in zip(subscriptions, results):
        if success:
            sent_count += 1
        else:
            expired_ids.append(sub.id)
    return sent_count, expired_ids


async def send_push(
    session: AsyncSession,
    user_id: uuid.UUID,
    title: str,
    body: str,
    data: dict[str, Any] | None = None,
    category: str | None = None,
    user_preferences: dict[str, Any] | None = None,
) -> int:
    """Send a Web Push notification to all active subscriptions for a user.

    Args:
        session: Database session.
        user_id: Target user UUID.
        title: Notification title.
        body: Notification body text.
        data: Optional data payload (passed to service worker).
        category: Notification type string for preference filtering.
        user_preferences: User's notification_preferences dict.

    Returns:
        Number of successfully sent push messages.
    """
    # Phase E.0: Expo 구독은 VAPID 키 없이도 동작
    # Check user preferences
    notification_type = category or ""
    if not _should_send(notification_type, user_preferences):
        return 0

    subscriptions = await _get_active_subscriptions(session, user_id)
    if not subscriptions:
        return 0

    payload = json.dumps(
        {
            "title": title,
            "body": body,
            "data": data or {},
            "category": category,
        },
        ensure_ascii=False,
        default=str,
    )

    sent_count, expired_ids = await _dispatch_pushes(
        subscriptions, payload, title=title, body=body, data=data, category=category
    )

    # Deactivate expired subscriptions in batch
    if expired_ids:
        await session.execute(
            update(PushSubscription)
            .where(PushSubscription.id.in_(expired_ids))
            .values(is_active=False)
        )
        await session.flush()
        logger.info(
            "Deactivated %d expired push subscriptions for user %s",
            len(expired_ids),
            user_id,
        )

    return sent_count


async def send_push_to_many(
    session: AsyncSession,
    user_ids: list[uuid.UUID],
    title: str,
    body: str,
    data: dict[str, Any] | None = None,
    category: str | None = None,
) -> int:
    """Send push notifications to multiple users.

    Note: This does not check per-user preferences — caller should filter first
    or use send_push() per user for preference-aware sending.

    Returns:
        Total number of successfully sent push messages.
    """
    if not user_ids:
        return 0

    result = await session.execute(
        select(PushSubscription).where(
            PushSubscription.user_id.in_(user_ids),
            PushSubscription.is_active.is_(True),
        )
    )
    subscriptions = list(result.scalars().all())
    if not subscriptions:
        return 0

    payload = json.dumps(
        {
            "title": title,
            "body": body,
            "data": data or {},
            "category": category,
        },
        ensure_ascii=False,
        default=str,
    )

    sent_count, expired_ids = await _dispatch_pushes(
        subscriptions, payload, title=title, body=body, data=data, category=category
    )

    if expired_ids:
        await session.execute(
            update(PushSubscription)
            .where(PushSubscription.id.in_(expired_ids))
            .values(is_active=False)
        )
        await session.flush()

    return sent_count


async def send_notification(
    session: AsyncSession,
    user_id: uuid.UUID,
    category: str,
    title: str,
    body: str,
    data: dict[str, Any] | None = None,
    event_id: uuid.UUID | None = None,
    tier_id: uuid.UUID | None = None,
) -> int:
    """Phase E.0 — 통합 알림 발송 래퍼.

    NotificationService.notify() (DB insert + Redis SSE publish) 와
    send_push() (VAPID/Expo 발송) 를 단일 진입점으로 묶어, 호출부가
    notify() 시그니처에 결합되지 않도록 한다.

    - category: 알림 type 문자열 (예: "PRICE_DROP", "WEEKLY_CURATION")
    - 사용자의 notification_preferences 를 로드해 push 단계에서 필터링
    - DB notification 은 prefs 와 무관하게 항상 기록 (인박스 용도)

    Returns:
        전송된 푸시 메시지 개수.
    """
    # Lazy import — 순환 의존 방지
    from app.services.notification_service import NotificationService

    # 1) DB + SSE
    try:
        service = NotificationService(session)
        await service.notify(
            user_id=user_id,
            event_id=event_id,  # nullable — 컬럼은 nullable=True
            type=category,
            message=body,
            data={**(data or {}), "title": title},
            tier_id=tier_id,
        )
    except Exception:
        logger.exception(
            "send_notification: failed to persist/publish notification (user=%s, category=%s)",
            user_id,
            category,
        )

    # 2) 사용자 preferences 조회 → push 단계 필터링
    prefs_row = await session.execute(
        select(User.notification_preferences).where(User.id == user_id)
    )
    prefs = prefs_row.scalar_one_or_none() or {}

    # 3) Push 발송
    return await send_push(
        session=session,
        user_id=user_id,
        title=title,
        body=body,
        data=data,
        category=category,
        user_preferences=prefs,
    )
