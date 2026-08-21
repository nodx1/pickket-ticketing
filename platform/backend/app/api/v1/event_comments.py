"""Event comment endpoints for community feed."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.sanitize import sanitize_plain_text
from app.middleware.auth import get_current_user, get_current_user_optional
from app.models.event import Event
from app.models.event_comment import EventComment, EventCommentLike
from app.models.user import User
from app.models.order import Order, OrderStatus
from app.schemas.event_comment import CommentCreate, CommentResponse, CommentListResponse

router = APIRouter()


def _determine_role(user: User, event: Event) -> str:
    """Determine commenter role based on relationship to event."""
    if event.organizer_id and event.organizer_id == user.id:
        return "organizer"
    if event.artist_id and event.artist_id == user.id:
        return "artist"
    return "fan"  # verified_attendee checked separately via order


@router.post("/{event_id}/comments", response_model=CommentResponse, status_code=201)
async def create_comment(
    event_id: uuid.UUID,
    data: CommentCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a comment on an event."""
    # Check event exists
    event_result = await db.execute(select(Event).where(Event.id == event_id))
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="행사를 찾을 수 없습니다")

    # Check parent exists if replying
    if data.parent_id:
        parent_result = await db.execute(
            select(EventComment.id).where(
                EventComment.id == data.parent_id,
                EventComment.event_id == event_id,
            )
        )
        if not parent_result.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="원본 댓글을 찾을 수 없습니다")

    # Determine role
    role = _determine_role(user, event)
    if role == "fan":
        # Check if user is a verified attendee
        order_check = await db.execute(
            select(Order.id)
            .where(
                Order.event_id == event_id,
                Order.user_id == user.id,
                Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
            )
            .limit(1)
        )
        if order_check.scalar_one_or_none():
            role = "verified_attendee"

    comment = EventComment(
        event_id=event_id,
        user_id=user.id,
        parent_id=data.parent_id,
        content=sanitize_plain_text(data.content),
        role=role,
    )
    db.add(comment)

    # Increment parent replies_count
    if data.parent_id:
        parent_result = await db.execute(
            select(EventComment).where(EventComment.id == data.parent_id)
        )
        parent = parent_result.scalar_one()
        parent.replies_count += 1

    await db.commit()
    await db.refresh(comment)

    # Quest 자동 진행 — "댓글 남기기" daily quest
    try:
        from app.services.quest_service import QuestService
        await QuestService(db).complete_by_condition(user.id, "comment")
        await db.commit()
    except Exception:  # noqa: BLE001
        pass  # Quest 진행 실패는 댓글 작성 자체를 막지 않음

    return CommentResponse(
        id=comment.id,
        event_id=comment.event_id,
        user_id=comment.user_id,
        parent_id=comment.parent_id,
        content=comment.content,
        role=comment.role,
        likes_count=0,
        replies_count=0,
        is_pinned=False,
        user_name=user.name,
        user_avatar=user.avatar_url,
        is_liked_by_me=False,
        created_at=comment.created_at,
    )


@router.get("/{event_id}/comments", response_model=CommentListResponse)
async def get_event_comments(
    event_id: uuid.UUID,
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=50),
    sort: str = Query("recent", pattern="^(recent|popular)$"),
    filter: str = Query("all", pattern="^(all|official|fan|verified)$"),
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_read_db),
):
    """Get comments for an event."""
    # Base query
    query = (
        select(
            EventComment,
            User.name.label("user_name"),
            User.avatar_url.label("user_avatar"),
        )
        .join(User, EventComment.user_id == User.id)
        .where(
            EventComment.event_id == event_id,
            EventComment.is_hidden == False,  # noqa: E712
            EventComment.parent_id == None,  # noqa: E711 — top-level only
        )
    )

    # Apply filter
    if filter == "official":
        query = query.where(EventComment.role.in_(["organizer", "artist"]))
    elif filter == "fan":
        query = query.where(EventComment.role == "fan")
    elif filter == "verified":
        query = query.where(EventComment.role == "verified_attendee")

    # Count total
    count_q = select(func.count()).select_from(query.subquery())
    total = await db.scalar(count_q) or 0

    # Sort
    if sort == "popular":
        query = query.order_by(EventComment.likes_count.desc(), EventComment.created_at.desc())
    else:
        query = query.order_by(EventComment.is_pinned.desc(), EventComment.created_at.desc())

    query = query.offset(skip).limit(limit)
    result = await db.execute(query)
    rows = result.all()

    # Check likes if user is authenticated
    liked_ids: set[uuid.UUID] = set()
    if user and rows:
        comment_ids = [row[0].id for row in rows]
        likes_result = await db.execute(
            select(EventCommentLike.comment_id).where(
                EventCommentLike.user_id == user.id,
                EventCommentLike.comment_id.in_(comment_ids),
            )
        )
        liked_ids = {row[0] for row in likes_result.all()}

    items = [
        CommentResponse(
            id=comment.id,
            event_id=comment.event_id,
            user_id=comment.user_id,
            parent_id=comment.parent_id,
            content=comment.content,
            role=comment.role,
            likes_count=comment.likes_count,
            replies_count=comment.replies_count,
            is_pinned=comment.is_pinned,
            user_name=user_name,
            user_avatar=user_avatar,
            is_liked_by_me=comment.id in liked_ids,
            created_at=comment.created_at,
        )
        for comment, user_name, user_avatar in rows
    ]

    return CommentListResponse(
        items=items,
        total=total,
        has_more=(skip + limit) < total,
    )


@router.post("/{event_id}/comments/{comment_id}/like")
async def toggle_comment_like(
    event_id: uuid.UUID,
    comment_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Toggle like on a comment."""
    # Check comment exists
    comment_result = await db.execute(
        select(EventComment).where(
            EventComment.id == comment_id,
            EventComment.event_id == event_id,
        )
    )
    comment = comment_result.scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="댓글을 찾을 수 없습니다")

    # Check existing like
    existing = await db.execute(
        select(EventCommentLike).where(
            EventCommentLike.comment_id == comment_id,
            EventCommentLike.user_id == user.id,
        )
    )
    like = existing.scalar_one_or_none()

    if like:
        await db.delete(like)
        comment.likes_count = max(0, comment.likes_count - 1)
        is_liked = False
    else:
        new_like = EventCommentLike(comment_id=comment_id, user_id=user.id)
        db.add(new_like)
        comment.likes_count += 1
        is_liked = True

    await db.commit()
    return {"is_liked": is_liked, "likes_count": comment.likes_count}


@router.delete("/{event_id}/comments/{comment_id}", status_code=204)
async def delete_comment(
    event_id: uuid.UUID,
    comment_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Soft-delete own comment."""
    result = await db.execute(
        select(EventComment).where(
            EventComment.id == comment_id,
            EventComment.event_id == event_id,
            EventComment.user_id == user.id,
        )
    )
    comment = result.scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="댓글을 찾을 수 없습니다")

    comment.is_hidden = True
    comment.content = "(삭제된 댓글입니다)"
    await db.commit()
