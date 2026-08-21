"""Group formation endpoints for group bidding."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.errors import client_error_detail
from app.middleware.auth import get_current_user
from app.models.user import User
from app.schemas.group import (
    GroupCreateRequest,
    GroupResponse,
    GroupListResponse,
)
from app.services.group_service import GroupService

router = APIRouter()


@router.post("/", response_model=GroupResponse, status_code=status.HTTP_201_CREATED)
async def create_group(
    data: GroupCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new group for group bidding."""
    svc = GroupService(db)
    try:
        group = await svc.create_group(
            leader_id=user.id,
            event_id=data.event_id,
            tier_id=data.tier_id,
            require_adjacent=data.require_adjacent,
        )
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=client_error_detail(e, "요청을 처리할 수 없습니다"))

    detail = await svc.get_group(group.id)
    return GroupResponse(**detail)


@router.get("/{group_id}", response_model=GroupResponse)
async def get_group(
    group_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Get group detail with members."""
    svc = GroupService(db)
    detail = await svc.get_group(group_id)
    if not detail:
        raise HTTPException(status_code=404, detail="그룹을 찾을 수 없습니다.")
    return GroupResponse(**detail)


@router.post("/join/{code}", response_model=GroupResponse)
async def join_group(
    code: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Join a group by invitation code."""
    svc = GroupService(db)
    try:
        member = await svc.join_by_code(user.id, code)
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=client_error_detail(e, "요청을 처리할 수 없습니다"))

    detail = await svc.get_group(member.group_id)
    return GroupResponse(**detail)


@router.delete("/{group_id}/members/me", status_code=status.HTTP_200_OK)
async def leave_group(
    group_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Leave a group (if leader, disbands the group)."""
    svc = GroupService(db)
    try:
        await svc.leave_group(group_id, user.id)
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=client_error_detail(e, "요청을 처리할 수 없습니다"))
    return {"detail": "그룹에서 탈퇴했습니다."}


@router.get("/my/active", response_model=GroupListResponse)
async def my_groups(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """List my active groups."""
    svc = GroupService(db)
    groups = await svc.get_user_groups(user.id)
    return GroupListResponse(groups=[GroupResponse(**g) for g in groups])
