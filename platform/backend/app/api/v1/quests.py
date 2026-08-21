"""Quest, Badge, and Attendance API endpoints (WP14 Gamification).

Endpoints:
    GET  /daily           - Today's daily quests with completion status
    GET  /weekly          - This week's weekly quests with completion status
    POST /check-in        - Daily attendance check-in
    GET  /badges/my       - Current user's badge collection
    GET  /attendance/streak - Attendance streak info
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import client_error_detail

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_user
from app.models.quest import QuestType
from app.models.user import User
from app.schemas.quest import (
    AttendanceStreakResponse,
    BadgeListResponse,
    BadgeResponse,
    CheckInResponse,
    QuestListResponse,
    QuestResponse,
)
from app.services.attendance_service import AttendanceService
from app.services.badge_service import BadgeService
from app.services.quest_service import QuestService

router = APIRouter()


@router.get("/daily", response_model=QuestListResponse)
async def get_daily_quests(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Return today's daily quests with completion status."""
    svc = QuestService(db)
    quests = await svc.get_quests_with_status(user.id, QuestType.DAILY)
    return QuestListResponse(
        quests=[QuestResponse(**q) for q in quests],
        total=len(quests),
    )


@router.get("/weekly", response_model=QuestListResponse)
async def get_weekly_quests(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Return this week's weekly quests with completion status."""
    svc = QuestService(db)
    quests = await svc.get_quests_with_status(user.id, QuestType.WEEKLY)
    return QuestListResponse(
        quests=[QuestResponse(**q) for q in quests],
        total=len(quests),
    )


@router.post("/check-in", response_model=CheckInResponse)
async def daily_check_in(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Record daily attendance check-in and earn AP."""
    svc = AttendanceService(db)
    try:
        result = await svc.check_in(user.id, source="manual")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=client_error_detail(e, "출석 체크에 실패했습니다"))
    await db.commit()
    return CheckInResponse(**result)


@router.get("/badges/my", response_model=BadgeListResponse)
async def get_my_badges(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Return current user's earned badges."""
    svc = BadgeService(db)
    badges = await svc.get_user_badges(user.id)
    return BadgeListResponse(
        badges=[BadgeResponse(**b) for b in badges],
        total=len(badges),
    )


@router.post("/track/{condition_type}", response_model=dict)
async def track_quest_action(
    condition_type: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Frontend가 사용자 액션 (이벤트 둘러보기, 커뮤니티 참여 등) 발생 시 호출.

    매칭되는 활성 quest 가 있으면 즉시 complete 처리. 이미 완료한 quest 는 skip.
    """
    svc = QuestService(db)
    completed = await svc.complete_by_condition(user.id, condition_type)
    await db.commit()
    return {"completed_count": completed, "condition_type": condition_type}


@router.get("/attendance/streak", response_model=AttendanceStreakResponse)
async def get_attendance_streak(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Return attendance streak info for the current user."""
    svc = AttendanceService(db)
    streak = await svc.get_streak(user.id)
    return AttendanceStreakResponse(**streak)
