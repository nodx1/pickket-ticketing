"""Badge 도메인 라우터 (WP14 게이미피케이션).

컨트롤러 계층 — HTTP 요청을 파싱·검증하고 service 로 위임만 함.
DB 쿼리, 트랜잭션 관리, 비즈니스 로직 금지.

엔드포인트:
    GET  /badges        Badge 카탈로그 (정의 목록)
    GET  /badges/my     현재 사용자 획득 Badge
    POST /badges/check  조건 검사 후 신규 부여 트리거
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_user
from app.models.badge import Badge
from app.models.user import User
from app.repositories.badge.badge_repo import BadgeRepository
from app.schemas.badge.badge_responses import (
    BadgeCheckResult,
    BadgeListOut,
    BadgeOut,
    UserBadgeListOut,
    UserBadgeOut,
)
from app.services.badge.badge_service import BadgeService
from app.shared.openapi_responses import COMMON_AUTH_RESPONSES

router = APIRouter()


@router.get(
    "",
    response_model=BadgeListOut,
    summary="Badge 카탈로그",
    description=(
        "획득 가능한 모든 Badge 정의 목록.\n\n"
        "- 인증 불필요 (공개)\n"
        "- 정렬: 카테고리 → 이름 순\n"
        "- `condition_type`: `attendance_count`, `quest_count` 등\n"
        "- `condition_value`: 해당 카운트 임계값"
    ),
)
async def list_badges(
    db: AsyncSession = Depends(get_read_db),
):
    """Badge 카탈로그."""
    badges = await BadgeRepository(db).list_ordered()
    return BadgeListOut(
        badges=[BadgeOut.model_validate(b) for b in badges],
        total=len(badges),
    )


@router.get(
    "/my",
    response_model=UserBadgeListOut,
    summary="내가 획득한 Badge 목록",
    description="현재 사용자가 지금까지 획득한 Badge 들 (최신 획득순).",
    responses=COMMON_AUTH_RESPONSES,
)
async def get_my_badges(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """내 Badge."""
    svc = BadgeService(db)
    badges = await svc.get_user_badges(user.id)
    return UserBadgeListOut(
        badges=[UserBadgeOut(**b) for b in badges],
        total=len(badges),
    )


@router.post(
    "/check",
    response_model=BadgeCheckResult,
    summary="Badge 조건 검사 + 신규 부여",
    description=(
        "현재 사용자의 활동(출석·퀘스트 등)을 기반으로 조건을 충족한 Badge 를 자동 부여.\n\n"
        "- 퀘스트 완료 / 출석 후 호출 권장\n"
        "- 이미 가진 Badge 는 스킵\n"
        "- 응답 `newly_awarded`: 이번 호출에서 새로 부여된 Badge 들\n"
        "- 응답 `total_badges`: 현재 보유 Badge 총 개수"
    ),
    responses=COMMON_AUTH_RESPONSES,
)
async def check_badges(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Badge 조건 검사 + 부여."""
    svc = BadgeService(db)
    newly_awarded = await svc.check_and_award_badges(user.id)
    await db.commit()

    all_badges = await svc.get_user_badges(user.id)

    awarded_out = []
    for ub in newly_awarded:
        badge = await db.get(Badge, ub.badge_id)
        if badge:
            awarded_out.append(
                UserBadgeOut(
                    id=ub.id,
                    badge_id=badge.id,
                    name=badge.name,
                    description=badge.description,
                    icon_url=badge.icon_url,
                    category=badge.category,
                    earned_at=ub.earned_at,
                )
            )

    return BadgeCheckResult(
        newly_awarded=awarded_out,
        total_badges=len(all_badges),
    )
