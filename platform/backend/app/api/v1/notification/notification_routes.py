"""Notification 도메인 라우터 (컨트롤러).

컨트롤러 계층 — HTTP 요청을 파싱·검증하고 service 로 위임만 함.
DB 쿼리, 트랜잭션 관리, 비즈니스 로직 금지.

엔드포인트:
    POST   /notifications/stream-token             SSE 일회용 토큰
    GET    /notifications/stream                   SSE 스트림
    GET    /notifications/                         목록 + 미읽음 수
    GET    /notifications/unread-count             미읽음 수
    POST   /notifications/{id}/read                단건 읽음
    PATCH  /notifications/{id}/read                단건 읽음 (PATCH)
    POST   /notifications/read-all                 전체 읽음
    PATCH  /notifications/read-all                 전체 읽음 (PATCH)
    GET    /notifications/preferences              환경설정 조회
    PUT    /notifications/preferences              환경설정 갱신
"""
from __future__ import annotations

import asyncio
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.notification.dependencies import (
    STREAM_TOKEN_TTL_SECONDS,
    get_sse_user,
    stream_token_key,
)
from app.core.database import get_db, get_read_db
from app.core.redis import get_redis
from app.core.sse import (
    SSEConnection,
    format_heartbeat,
    format_sse,
    get_last_event_id,
)
from app.middleware.auth import get_current_user
from app.models.user import User
from app.schemas.notification.notification_responses import NotificationListResponse
from app.services.notification.notification_service import NotificationService
from app.shared.openapi_responses import (
    COMMON_AUTH_RESPONSES,
    NOT_FOUND_RESPONSE,
    SERVICE_UNAVAILABLE_RESPONSE,
)

router = APIRouter()


@router.post(
    "/stream-token",
    summary="SSE 일회용 스트림 토큰 발급",
    description=(
        "EventSource API 는 헤더 설정이 어려우므로 60초 TTL 의 일회용 토큰 발급.\n\n"
        "**사용 흐름**:\n"
        "1. 이 엔드포인트로 토큰 발급\n"
        "2. `GET /stream?stream_token=...` 로 SSE 연결\n"
        "3. 토큰은 1회 사용 시 즉시 폐기 (replay 방지)"
    ),
    responses={**COMMON_AUTH_RESPONSES, **SERVICE_UNAVAILABLE_RESPONSE},
)
async def create_notification_stream_token(
    user: User = Depends(get_current_user),
):
    """SSE 연결용 단명(60s) 토큰 발급."""
    try:
        redis = get_redis()
    except RuntimeError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Notification service unavailable",
        )

    token = uuid.uuid4().hex
    await redis.setex(stream_token_key(token), STREAM_TOKEN_TTL_SECONDS, str(user.id))
    return {"token": token, "expires_in": STREAM_TOKEN_TTL_SECONDS}


@router.get(
    "/stream",
    summary="SSE 실시간 알림 스트림",
    description=(
        "사용자별 Redis pub/sub 채널 (`sse:user:{user_id}`) 을 구독하여 새 알림을 실시간 푸시.\n\n"
        "**인증**: Authorization 헤더 또는 `?stream_token=...` 쿼리.\n"
        "**Content-Type**: `text/event-stream` (SSE)\n"
        "**Heartbeat**: 일정 시간 메시지 없으면 keep-alive 핑 전송"
    ),
    response_class=StreamingResponse,
    responses=COMMON_AUTH_RESPONSES,
)
async def notification_stream(
    request: Request,
    user: User = Depends(get_sse_user),
):
    """SSE 엔드포인트."""
    user_id = str(user.id)
    channel = f"sse:user:{user_id}"
    last_event_id = get_last_event_id(request)

    async def event_generator():
        conn = SSEConnection(last_event_id=last_event_id)
        pubsub = None
        try:
            try:
                redis = get_redis()
                pubsub = redis.pubsub()
                await pubsub.subscribe(channel)
            except (RuntimeError, AttributeError):
                pubsub = None

            while True:
                if await request.is_disconnected():
                    break

                emitted = False
                if pubsub is not None:
                    message = await pubsub.get_message(
                        ignore_subscribe_messages=True, timeout=1.0
                    )
                    if message and message.get("type") == "message":
                        payload = message.get("data")
                        if isinstance(payload, bytes):
                            payload = payload.decode("utf-8", errors="ignore")
                        if isinstance(payload, str) and conn.try_consume():
                            import json as _json

                            try:
                                data = _json.loads(payload)
                            except (ValueError, TypeError):
                                data = payload
                            eid = conn.next_id()
                            conn.reset_heartbeat()
                            yield format_sse(data, event_id=eid, event_type="notification")
                            emitted = True

                if not emitted:
                    if conn.needs_heartbeat():
                        yield format_heartbeat()
                    else:
                        await asyncio.sleep(0.1)
        finally:
            if pubsub is not None:
                await pubsub.unsubscribe(channel)
                await pubsub.close()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get(
    "/",
    response_model=NotificationListResponse,
    summary="알림 목록 + 미읽음 수",
    description=(
        "현재 사용자의 알림을 최신순으로 페이지네이션 반환.\n\n"
        "- `unread_only=true` 시 미읽음만 필터\n"
        "- 응답에 `unread_count` 포함 (Bell 아이콘 뱃지용)"
    ),
    responses=COMMON_AUTH_RESPONSES,
)
async def get_notifications(
    unread_only: bool = Query(False, description="미읽음만 보기"),
    skip: int = Query(0, ge=0, description="페이지네이션 offset"),
    limit: int = Query(50, ge=1, le=100, description="한 페이지 항목 수 (1-100)"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """알림 목록 + 미읽음 수."""
    service = NotificationService(db)
    return await service.get_notifications(
        user.id,
        unread_only=unread_only,
        skip=skip,
        limit=limit,
    )


@router.get(
    "/unread-count",
    summary="미읽음 알림 개수",
    description="Bell 아이콘 뱃지 표시용 경량 엔드포인트.",
    responses=COMMON_AUTH_RESPONSES,
)
async def unread_count(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """미읽음 알림 개수."""
    service = NotificationService(db)
    return {"count": await service.get_unread_count(user.id)}


@router.post(
    "/{notification_id}/read",
    summary="단건 알림 읽음 처리",
    description="알림 하나를 읽음 상태로 변경. 본인 알림만 처리 가능.",
    responses={**COMMON_AUTH_RESPONSES, **NOT_FOUND_RESPONSE},
)
async def mark_notification_read(
    notification_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """단건 읽음 처리."""
    service = NotificationService(db)
    updated = await service.mark_read_for_user(notification_id, user.id)
    if not updated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found"
        )
    await db.commit()
    return {"ok": True}


@router.patch(
    "/{notification_id}/read",
    summary="단건 알림 읽음 처리 (PATCH)",
    description="POST 와 동일 동작. REST 의미상 멱등 호출(PATCH)을 선호하는 클라이언트용.",
    responses={**COMMON_AUTH_RESPONSES, **NOT_FOUND_RESPONSE},
)
async def mark_notification_read_patch(
    notification_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """단건 읽음 처리 (PATCH 변종)."""
    service = NotificationService(db)
    updated = await service.mark_as_read(notification_id, user.id)
    if not updated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found"
        )
    await db.commit()
    return {"ok": True}


@router.post(
    "/read-all",
    summary="전체 알림 일괄 읽음",
    description="현재 사용자의 모든 미읽음 알림을 한 번에 읽음 처리. 응답 `updated` = 처리된 건수.",
    responses=COMMON_AUTH_RESPONSES,
)

async def mark_all_notifications_read(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """전체 일괄 읽음."""
    service = NotificationService(db)
    count = await service.mark_all_read(user.id)
    await db.commit()
    return {"ok": True, "updated": count}


@router.patch(
    "/read-all",
    summary="전체 알림 일괄 읽음 (PATCH)",
    description="POST 와 동일. 응답 키만 `marked` 로 다름 (legacy 호환).",
    responses=COMMON_AUTH_RESPONSES,
)
async def mark_all_notifications_read_patch(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """전체 일괄 읽음 (PATCH 변종)."""
    service = NotificationService(db)
    count = await service.mark_all_as_read(user.id)
    await db.commit()
    return {"marked": count}


@router.get(
    "/preferences",
    summary="알림 환경설정 조회",
    description=(
        "사용자별 알림 ON/OFF 설정.\n\n"
        "**기본값과 머지** 되어 반환 — 미설정 키는 default 사용.\n"
        "**카테고리**:\n"
        "- 시스템: `allocation_result`, `payment_reminder`, `event_update`, `price_alert`\n"
        "- 채널: `email_enabled`, `sms_enabled`, `push_enabled`\n"
        "- 마케팅: `marketing`\n"
        "- Phase E (opt-in 기본 OFF): `location_based`, `price_watch`, `weekly_curation`, `friend_activity`"
    ),
    responses=COMMON_AUTH_RESPONSES,
)
async def get_notification_preferences(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """환경설정 조회."""
    defaults = {
        "allocation_result": True,
        "payment_reminder": True,
        "event_update": True,
        "price_alert": True,
        "marketing": False,
        "email_enabled": True,
        "sms_enabled": True,
        "push_enabled": True,
        # Phase E: opt-in 원칙 (기본 OFF)
        "location_based": False,
        "price_watch": False,
        "weekly_curation": False,
        "friend_activity": False,
    }
    prefs = user.notification_preferences or {}
    return {**defaults, **prefs}


@router.put(
    "/preferences",
    summary="알림 환경설정 갱신",
    description=(
        "허용 키만 부분 갱신 (whitelist). 알 수 없는 키는 무시.\n\n"
        "**Request body**: `{ \"push_enabled\": true, \"marketing\": false, ... }` (bool 값)"
    ),
    responses=COMMON_AUTH_RESPONSES,
)
async def update_notification_preferences(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """환경설정 갱신."""
    body = await request.json()
    allowed_keys = {
        "allocation_result",
        "payment_reminder",
        "event_update",
        "price_alert",
        "marketing",
        "email_enabled",
        "sms_enabled",
        "push_enabled",
        # Phase E
        "location_based",
        "price_watch",
        "weekly_curation",
        "friend_activity",
    }
    prefs = {k: bool(v) for k, v in body.items() if k in allowed_keys}

    current = user.notification_preferences or {}
    current.update(prefs)
    user.notification_preferences = current

    await db.commit()
    return current
