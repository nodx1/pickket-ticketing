"""Friendship API — Phase E.4 최소 골격.

요청 보내기 / 수락 / 목록 조회만 제공. 검색·그룹 예매·전화번호 매칭 등은
Phase C 전체 구현 시 확장한다.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_user
from app.models.friendship import Friendship, FriendshipStatus
from app.models.user import User
from app.services.push_service import send_notification

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Schemas ──────────────────────────────────────────────────────────────────


class FriendRequestCreate(BaseModel):
    friend_id: uuid.UUID


class FriendshipRead(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    friend_id: uuid.UUID
    status: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class FriendUserRead(BaseModel):
    id: uuid.UUID
    name: str | None = None
    profile_image_url: str | None = None
    friendship_status: str


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.post(
    "/friends/request",
    response_model=FriendshipRead,
    status_code=status.HTTP_201_CREATED,
)
async def send_friend_request(
    body: FriendRequestCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Send a friend request. Creates a pending row (user_id → friend_id)."""
    if body.friend_id == user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot befriend yourself",
        )

    # Target must exist
    target = await db.get(User, body.friend_id)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    # Existing friendship?
    existing = await db.execute(
        select(Friendship).where(
            Friendship.user_id == user.id,
            Friendship.friend_id == body.friend_id,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Friend request already exists",
        )

    friendship = Friendship(
        user_id=user.id,
        friend_id=body.friend_id,
        status=FriendshipStatus.PENDING,
    )
    db.add(friendship)
    await db.commit()
    await db.refresh(friendship)

    # Notify recipient
    try:
        await send_notification(
            session=db,
            user_id=body.friend_id,
            category="FRIEND_ACTIVITY",
            title="친구 요청",
            body=f"{user.name or '누군가'}님이 친구 요청을 보냈어요",
            data={"from_user_id": str(user.id)},
        )
    except Exception:  # noqa: BLE001
        logger.debug("friendship event webhook failed", exc_info=True)

    return friendship


@router.post("/friends/{friendship_id}/accept", response_model=FriendshipRead)
async def accept_friend_request(
    friendship_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Accept an incoming friend request."""
    friendship = await db.get(Friendship, friendship_id)
    if friendship is None or friendship.friend_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Friend request not found",
        )
    if friendship.status != FriendshipStatus.PENDING:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Request is not pending",
        )

    friendship.status = FriendshipStatus.ACCEPTED

    # Reciprocal row (for bidirectional queries)
    reverse = await db.execute(
        select(Friendship).where(
            Friendship.user_id == friendship.friend_id,
            Friendship.friend_id == friendship.user_id,
        )
    )
    if reverse.scalar_one_or_none() is None:
        db.add(
            Friendship(
                user_id=friendship.friend_id,
                friend_id=friendship.user_id,
                status=FriendshipStatus.ACCEPTED,
            )
        )

    await db.commit()
    await db.refresh(friendship)

    # Notify original requester
    try:
        await send_notification(
            session=db,
            user_id=friendship.user_id,
            category="FRIEND_ACTIVITY",
            title="친구 수락",
            body=f"{user.name or '상대'}님이 친구 요청을 수락했어요",
            data={"friend_id": str(user.id)},
        )
    except Exception:  # noqa: BLE001
        logger.debug("friendship event webhook failed", exc_info=True)

    return friendship


@router.delete(
    "/friends/{friendship_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def decline_or_remove_friend(
    friendship_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Decline a pending request or remove an accepted friend (both directions)."""
    friendship = await db.get(Friendship, friendship_id)
    if friendship is None or user.id not in (
        friendship.user_id,
        friendship.friend_id,
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Friendship not found",
        )

    # Delete both directions
    result = await db.execute(
        select(Friendship).where(
            or_(
                and_(
                    Friendship.user_id == friendship.user_id,
                    Friendship.friend_id == friendship.friend_id,
                ),
                and_(
                    Friendship.user_id == friendship.friend_id,
                    Friendship.friend_id == friendship.user_id,
                ),
            )
        )
    )
    for row in result.scalars().all():
        await db.delete(row)
    await db.commit()


@router.get("/friends", response_model=list[FriendUserRead])
async def list_friends(
    status_filter: str | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """List friends (accepted by default) + optional pending filter.

    `status_filter`: "accepted" | "pending_incoming" | "pending_outgoing"
    """
    if status_filter == "pending_incoming":
        stmt = (
            select(Friendship, User)
            .join(User, User.id == Friendship.user_id)
            .where(
                Friendship.friend_id == user.id,
                Friendship.status == FriendshipStatus.PENDING,
            )
        )
    elif status_filter == "pending_outgoing":
        stmt = (
            select(Friendship, User)
            .join(User, User.id == Friendship.friend_id)
            .where(
                Friendship.user_id == user.id,
                Friendship.status == FriendshipStatus.PENDING,
            )
        )
    else:
        stmt = (
            select(Friendship, User)
            .join(User, User.id == Friendship.friend_id)
            .where(
                Friendship.user_id == user.id,
                Friendship.status == FriendshipStatus.ACCEPTED,
            )
        )

    result = await db.execute(stmt)
    rows = result.all()
    return [
        FriendUserRead(
            id=u.id,
            name=u.name,
            profile_image_url=getattr(u, "profile_image_url", None),
            friendship_status=f.status,
        )
        for f, u in rows
    ]
