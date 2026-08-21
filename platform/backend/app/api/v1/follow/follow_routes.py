"""Follow 도메인 라우터 (컨트롤러).

컨트롤러 계층 — HTTP 요청을 파싱·검증하고 service 로 위임만 함.
DB 쿼리, 트랜잭션 관리, 비즈니스 로직 금지.

엔드포인트:
    POST   /follows/{user_id}            팔로우 토글
    GET    /follows/{user_id}/status     팔로우 상태 + 카운터
    GET    /follows/{user_id}/followers  팔로워 목록
    GET    /follows/{user_id}/following  팔로잉 목록
    GET    /follows/me/following-ids     내가 팔로우하는 ID 전체 (피드용)
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.errors import client_error_detail
from app.middleware.auth import get_current_user, get_current_user_optional
from app.models.user import User
from app.schemas.follow.follow_responses import FollowerListResponse, FollowStatus
from app.services.follow.follow_service import FollowService
from app.shared.openapi_responses import (
    COMMON_AUTH_RESPONSES,
    VALIDATION_RESPONSE,
)

router = APIRouter()


@router.post(
    "/{user_id}",
    status_code=status.HTTP_200_OK,
    summary="팔로우 토글",
    description=(
        "주최자/아티스트/다른 사용자를 팔로우하거나, 이미 팔로우 중이면 언팔로우.\n\n"
        "- **자기 자신 팔로우** 시 400 반환\n"
        "- **응답 `is_following`**: true=새로 팔로우, false=언팔로우"
    ),
    responses={**COMMON_AUTH_RESPONSES, **VALIDATION_RESPONSE},
)
async def toggle_follow(
    user_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """팔로우 토글."""
    service = FollowService(db)
    try:
        is_following = await service.toggle(current_user.id, user_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=client_error_detail(e, "팔로우 처리 중 오류가 발생했습니다"),
        )
    return {"is_following": is_following}


@router.get(
    "/{user_id}/status",
    response_model=FollowStatus,
    summary="팔로우 상태 + 카운터",
    description=(
        "타인 프로필 페이지에서 팔로우 버튼 표시용.\n\n"
        "- **로그인 안 한 경우**: `is_following=false`, 카운터만 반환\n"
        "- **로그인 한 경우**: 현재 사용자 기준 팔로우 여부 + 카운터"
    ),
)
async def get_follow_status(
    user_id: uuid.UUID,
    current_user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_read_db),
):
    """팔로우 상태 + 카운터."""
    service = FollowService(db)
    if current_user:
        return await service.get_status(current_user.id, user_id)
    return {
        "is_following": False,
        "follower_count": await service.get_follower_count(user_id),
        "following_count": await service.get_following_count(user_id),
    }


@router.get(
    "/{user_id}/followers",
    response_model=FollowerListResponse,
    summary="팔로워 목록",
    description="특정 사용자를 팔로우하는 사람들의 페이지네이션 목록.",
)
async def get_followers(
    user_id: uuid.UUID,
    limit: int = Query(20, ge=1, le=100, description="한 페이지 항목 수 (1-100)"),
    offset: int = Query(0, ge=0, description="페이지네이션 offset"),
    db: AsyncSession = Depends(get_read_db),
):
    """팔로워 목록."""
    service = FollowService(db)
    items, total = await service.get_followers(user_id, limit=limit, offset=offset)
    return {
        "items": items,
        "total": total,
        "has_more": offset + limit < total,
    }


@router.get(
    "/{user_id}/following",
    response_model=FollowerListResponse,
    summary="팔로잉 목록",
    description="특정 사용자가 팔로우하는 사람들의 페이지네이션 목록.",
)
async def get_following(
    user_id: uuid.UUID,
    limit: int = Query(20, ge=1, le=100, description="한 페이지 항목 수 (1-100)"),
    offset: int = Query(0, ge=0, description="페이지네이션 offset"),
    db: AsyncSession = Depends(get_read_db),
):
    """팔로잉 목록."""
    service = FollowService(db)
    items, total = await service.get_following(user_id, limit=limit, offset=offset)
    return {
        "items": items,
        "total": total,
        "has_more": offset + limit < total,
    }


@router.get(
    "/me/following-ids",
    response_model=list[uuid.UUID],
    summary="내가 팔로우하는 모든 ID",
    description=(
        "피드 쿼리용 경량 엔드포인트.\n\n"
        "현재 사용자가 팔로우하는 **모든 사용자 ID 만** 배열로 반환 (사용자 정보 없음). "
        "팔로우 기반 피드 필터링 시 클라이언트가 이 ID 목록으로 추가 쿼리."
    ),
    responses=COMMON_AUTH_RESPONSES,
)
async def get_my_following_ids(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """피드용 팔로잉 ID 전체."""
    service = FollowService(db)
    return await service.get_following_ids(current_user.id)
