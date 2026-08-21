"""Notification 도메인 FastAPI 의존성.

SSE 스트림 인증처럼 라우터에서만 쓰이는 Depends 헬퍼.
"""
import uuid

from fastapi import Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.redis import get_redis, v2_key
from app.core.security import decode_access_token_payload
from app.models.user import User
from app.services.token_blacklist import is_token_blacklisted

STREAM_TOKEN_TTL_SECONDS = 60


def stream_token_key(token: str) -> str:
    """SSE 스트림 토큰의 Redis 키. v2: prefix 강제 (DOMAIN_MODEL_STANDARD §7)."""
    return v2_key(f"sse:stream-token:{token}")


# 구 라우터 호환 — Phase 11 제거 예정
_stream_token_key = stream_token_key


async def get_sse_user(
    request: Request,
    stream_token: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    """SSE 연결 인증 — one-time stream token 또는 Authorization 헤더.

    EventSource API 는 헤더 설정이 어려우므로 60초 TTL 의 일회용 토큰을
    POST /notifications/stream-token 으로 받은 뒤 쿼리 파라미터로 전달.
    """
    user_id_str: str | None = None

    if stream_token:
        try:
            redis = get_redis()
        except RuntimeError:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Notification service unavailable",
            )
        cached = await redis.get(stream_token_key(stream_token))
        if not cached:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired stream token",
            )
        user_id_str = cached.decode() if isinstance(cached, bytes) else str(cached)
        # 로그/리퍼러 누출 시 재사용 방지 위해 즉시 삭제.
        await redis.delete(stream_token_key(stream_token))
    else:
        auth_header = request.headers.get("authorization", "")
        if auth_header.lower().startswith("bearer "):
            raw_token = auth_header[7:]
        else:
            raw_token = None

        if not raw_token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing authentication token",
            )

        payload = decode_access_token_payload(raw_token)
        if not payload:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired token",
            )

        jti = payload.get("jti")
        if jti and await is_token_blacklisted(str(jti)):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token has been revoked",
            )
        user_id_str = payload.get("sub")

    try:
        user_id = uuid.UUID(str(user_id_str))
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    result = await db.execute(select(User).where(User.id == user_id, User.is_active.is_(True)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
        )
    return user


# 구 라우터 호환 — Phase 11 제거 예정
_get_sse_user = get_sse_user
