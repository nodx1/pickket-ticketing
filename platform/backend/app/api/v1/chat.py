"""챗봇 API — 2-Tier 고객지원 챗봇 엔드포인트.

Tier 0: 키워드 FAQ (무료, 빠름)
Tier 1: LLM + 도구 호출 (Tier 0 실패 시)
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.resilience import CircuitBreakerOpen
from app.middleware.auth import get_current_user_optional
from app.models.user import User
from app.services.chatbot_service import handle_chat_message

router = APIRouter()
logger = logging.getLogger(__name__)

# ── 레이트 리밋 (인메모리, 프로덕션에서는 Redis) ──────────────────────────────

_RATE_LIMIT_WINDOW = 60  # 초
_RATE_LIMIT_MAX = 20  # 분당 메시지 수
_rate_limit_store: dict[str, list[float]] = {}


def _check_rate_limit(client_key: str) -> None:
    """분당 메시지 수 제한 체크."""
    now = time.time()
    if client_key not in _rate_limit_store:
        _rate_limit_store[client_key] = []

    # 윈도우 밖의 오래된 항목 제거
    _rate_limit_store[client_key] = [
        ts for ts in _rate_limit_store[client_key] if now - ts < _RATE_LIMIT_WINDOW
    ]

    if len(_rate_limit_store[client_key]) >= _RATE_LIMIT_MAX:
        raise HTTPException(
            status_code=429,
            detail="메시지 전송 한도를 초과했습니다. 잠시 후 다시 시도해주세요.",
        )

    _rate_limit_store[client_key].append(now)


# ── 요청/응답 스키마 ─────────────────────────────────────────────────────────


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=1000, description="사용자 메시지")
    conversation_id: str | None = Field(None, description="대화 ID (기존 대화 이어가기)")
    event_id: str | None = Field(
        None,
        description="문의 대상 이벤트 ID (특정 이벤트 페이지에서 열린 챗봇이면 해당 이벤트 context 주입)",
    )


class ChatMessageResponse(BaseModel):
    response: str = Field(..., description="챗봇 응답 메시지")
    tier: int = Field(..., description="응답 계층 (0=FAQ, 1=LLM)")
    conversation_id: str = Field(..., description="대화 ID")
    escalated: bool = Field(False, description="상담원 에스컬레이션 여부")


# ── 엔드포인트 ───────────────────────────────────────────────────────────────


@router.post("/chat", response_model=ChatMessageResponse)
async def send_chat_message(
    body: ChatRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user_optional),
):
    """챗봇 메시지 전송 — Tier 0 (FAQ) → Tier 1 (LLM) 자동 에스컬레이션.

    인증 없이도 사용 가능하며, 인증된 사용자는 주문/티켓 조회 기능을 이용할 수 있습니다.
    """
    # 레이트 리밋: 인증 사용자는 user_id, 미인증은 IP 기반
    if user:
        client_key = f"user:{user.id}"
    else:
        client_key = f"ip:{request.client.host if request.client else 'unknown'}"

    _check_rate_limit(client_key)

    user_id = str(user.id) if user else None

    result = await handle_chat_message(
        message=body.message.strip(),
        conversation_id=body.conversation_id,
        db=db,
        user_id=user_id,
        event_id=body.event_id,
    )

    return ChatMessageResponse(
        response=result.response,
        tier=result.tier,
        conversation_id=result.conversation_id,
        escalated=result.escalated,
    )
