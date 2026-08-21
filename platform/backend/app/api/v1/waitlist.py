"""Waitlist management endpoints.

FEATURE_FACE_VALUE_WAITLIST=false (기본) 시 503 "준비 중" 응답.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.v1.deps import verify_behavior_token
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.feature_flags import get_feature_flag
from app.middleware.auth import get_current_user
from app.models.user import User
from app.schemas.waitlist import WaitlistJoinRequest, WaitlistEntryResponse, WaitlistStatusResponse
from app.services.waitlist_service import WaitlistService

router = APIRouter()


async def _check_waitlist_enabled():
    """Feature flag 확인. 비활성 시 503."""
    enabled = await get_feature_flag("feature_face_value_waitlist", False)
    if not enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="대기열 서비스 준비 중입니다. 곧 오픈됩니다.",
        )


@router.post(
    "/{event_id}/tiers/{tier_id}/waitlist",
    response_model=WaitlistEntryResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_behavior_token), Depends(_check_waitlist_enabled)],
    summary="대기열 등록",
    description="매진된 등급의 대기열에 등록합니다. 팬 가중치 기반 우선순위가 자동 부여됩니다. 취소표 발생 시 순번대로 구매 기회가 제공됩니다.",
    openapi_extra={"x-agent-hint": "Auth + behavior token required. POST WaitlistJoinRequest with quantity, optional group_id. Priority computed from fan weight. Notified when spot opens."},
)
async def join_waitlist(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    data: WaitlistJoinRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Join the waitlist for a sold-out tier."""
    try:
        service = WaitlistService(db)
        entry = await service.add(
            user_id=user.id,
            event_id=event_id,
            tier_id=tier_id,
            priority_score=0.0,  # Will be computed by service based on fan weight
            quantity=data.quantity,
            group_id=data.group_id,
        )
        await db.commit()
        return entry
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unable to join waitlist for this tier",
        )


@router.get(
    "/{event_id}/tiers/{tier_id}/waitlist/status",
    response_model=WaitlistStatusResponse,
    dependencies=[Depends(_check_waitlist_enabled)],
    summary="대기열 현황 조회",
    description="대기열의 현재 상태와 사용자의 순번(position)을 조회합니다.",
    openapi_extra={"x-agent-hint": "Auth required. Returns total waitlist size and user's current position."},
)
async def waitlist_status(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get current waitlist status including the user's position."""
    try:
        service = WaitlistService(db)
        status_info = await service.get_status(
            user_id=user.id,
            event_id=event_id,
            tier_id=tier_id,
        )
        return status_info
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Waitlist entry not found for this tier",
        )


@router.delete(
    "/{event_id}/tiers/{tier_id}/waitlist",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(_check_waitlist_enabled)],
    summary="대기열 탈퇴",
    description="대기열에서 현재 사용자를 제거합니다.",
    openapi_extra={"x-agent-hint": "Auth required. Removes current user from the waitlist for this tier."},
)
async def leave_waitlist(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove the current user from the waitlist for a tier."""
    try:
        service = WaitlistService(db)
        await service.remove(user_id=user.id, tier_id=tier_id)
        await db.commit()
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Waitlist entry not found for this tier",
        )
