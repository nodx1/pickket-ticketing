"""Post-event experience endpoints (P2-8).

Memories (digital souvenirs, photos, reviews, badges) and review prompts
for events that have ended.
"""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.sanitize import sanitize_plain_text
from app.middleware.auth import get_current_user, get_current_user_optional, get_current_organizer
from app.models.event import Event, EventStatus
from app.models.event_memory import EventMemory, MemoryType
from app.models.order import Order, OrderStatus
from app.models.user import User
from app.models.notification import NotificationModel
from app.schemas.event_memory import (
    EventMemoryCreate,
    EventMemoryResponse,
    ReviewPromptRequest,
    ReviewPromptResponse,
)

router = APIRouter()


# ── Helpers ──────────────────────────────────────────────────────────────────


async def _get_event_or_404(event_id: uuid.UUID, db: AsyncSession) -> Event:
    result = await db.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")
    return event


async def _is_attendee(event_id: uuid.UUID, user_id: uuid.UUID, db: AsyncSession) -> bool:
    """Check if user has a confirmed/paid order for this event."""
    result = await db.execute(
        select(Order.id)
        .where(
            Order.event_id == event_id,
            Order.user_id == user_id,
            Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
        )
        .limit(1)
    )
    return result.scalar_one_or_none() is not None


# ── 1. List public memories ──────────────────────────────────────────────────


@router.get(
    "/{event_id}/memories",
    response_model=list[EventMemoryResponse],
    summary="이벤트 추억 목록",
)
async def list_event_memories(
    event_id: uuid.UUID,
    memory_type: MemoryType | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=50),
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_read_db),
):
    """List public memories for an event. Includes own private memories if authenticated."""
    stmt = (
        select(EventMemory, User.name)
        .join(User, EventMemory.user_id == User.id)
        .where(EventMemory.event_id == event_id)
    )

    if user:
        # Show public + own private memories
        stmt = stmt.where(
            (EventMemory.is_public == True)  # noqa: E712
            | (EventMemory.user_id == user.id)
        )
    else:
        stmt = stmt.where(EventMemory.is_public == True)  # noqa: E712

    if memory_type:
        stmt = stmt.where(EventMemory.memory_type == memory_type)

    stmt = stmt.order_by(EventMemory.created_at.desc()).offset(skip).limit(limit)
    result = await db.execute(stmt)
    rows = result.all()

    return [
        EventMemoryResponse(
            id=memory.id,
            event_id=memory.event_id,
            user_id=memory.user_id,
            memory_type=memory.memory_type,
            content=memory.content,
            title=memory.title,
            description=memory.description,
            is_public=memory.is_public,
            user_name=name or "",
            created_at=memory.created_at,
        )
        for memory, name in rows
    ]


# ── 2. Create memory ─────────────────────────────────────────────────────────


@router.post(
    "/{event_id}/memories",
    response_model=EventMemoryResponse,
    status_code=201,
    summary="추억 생성 (참석자만)",
)
async def create_event_memory(
    event_id: uuid.UUID,
    data: EventMemoryCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a memory for an attended event. Only confirmed order holders allowed."""
    event = await _get_event_or_404(event_id, db)

    # Event must have ended (completed or past event_date)
    now = datetime.now(timezone.utc)
    if event.status not in (EventStatus.COMPLETED,) and event.event_date > now:
        raise HTTPException(status_code=400, detail="이벤트가 아직 종료되지 않았습니다")

    if not await _is_attendee(event_id, user.id, db):
        raise HTTPException(status_code=403, detail="이벤트 참석자만 추억을 생성할 수 있습니다")

    memory = EventMemory(
        event_id=event_id,
        user_id=user.id,
        memory_type=data.memory_type,
        content=data.content,
        title=sanitize_plain_text(data.title) if data.title else None,
        description=sanitize_plain_text(data.description) if data.description else None,
        is_public=data.is_public,
    )
    db.add(memory)
    await db.commit()
    await db.refresh(memory)

    return EventMemoryResponse(
        id=memory.id,
        event_id=memory.event_id,
        user_id=memory.user_id,
        memory_type=memory.memory_type,
        content=memory.content,
        title=memory.title,
        description=memory.description,
        is_public=memory.is_public,
        user_name=user.name or "",
        created_at=memory.created_at,
    )


# ── 3. Review prompt ─────────────────────────────────────────────────────────


@router.post(
    "/{event_id}/review-prompt",
    response_model=ReviewPromptResponse,
    summary="리뷰 요청 발송 (주최자 전용)",
)
async def trigger_review_prompt(
    event_id: uuid.UUID,
    data: ReviewPromptRequest | None = None,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Trigger review request notifications to attendees.

    Only available after event end_date + 24h.
    Only the event organizer can trigger this.
    """
    event = await _get_event_or_404(event_id, db)

    # Must be the event organizer
    if event.organizer_id != user.id:
        raise HTTPException(status_code=403, detail="이벤트 주최자만 리뷰 요청을 보낼 수 있습니다")

    # Must be 24h after event end
    now = datetime.now(timezone.utc)
    review_eligible_time = event.event_date + timedelta(hours=24)
    if now < review_eligible_time:
        remaining = review_eligible_time - now
        hours_left = int(remaining.total_seconds() / 3600)
        raise HTTPException(
            status_code=400,
            detail=f"이벤트 종료 후 24시간이 지나야 리뷰 요청을 보낼 수 있습니다 (약 {hours_left}시간 후)",
        )

    # Find all attendees with confirmed orders
    attendee_result = await db.execute(
        select(Order.user_id)
        .where(
            Order.event_id == event_id,
            Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
        )
        .distinct()
    )
    attendee_ids = [row[0] for row in attendee_result.all()]

    if not attendee_ids:
        return ReviewPromptResponse(
            eligible_count=0,
            notified_count=0,
            message="알림을 보낼 참석자가 없습니다",
        )

    # Create notifications for each attendee
    custom_message = data.message if data else None
    default_message = f"'{event.title}' 이벤트는 어떠셨나요? 리뷰를 남겨주세요!"
    notification_message = custom_message or default_message

    notified = 0
    for attendee_id in attendee_ids:
        notification = NotificationModel(
            user_id=attendee_id,
            event_id=event_id,
            type="review_prompt",
            message=notification_message,
            data={"event_id": str(event_id), "event_title": event.title},
        )
        db.add(notification)
        notified += 1

    await db.commit()

    return ReviewPromptResponse(
        eligible_count=len(attendee_ids),
        notified_count=notified,
        message=f"{notified}명의 참석자에게 리뷰 요청을 보냈습니다",
    )
