"""Artist message endpoints — Weverse-style messages from organizers/artists to fans."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.sanitize import sanitize_plain_text
from app.middleware.auth import get_current_user
from app.models.event import Event
from app.models.artist_message import ArtistMessage
from app.models.user import User
from app.schemas.artist_message import (
    ArtistMessageCreate,
    ArtistMessageResponse,
    ArtistMessageListResponse,
    ReactionRequest,
)

router = APIRouter()


def _check_event_permission(user: User, event: Event) -> None:
    """Only organizer or artist of the event may post messages."""
    is_organizer = event.organizer_id and event.organizer_id == user.id
    is_artist = event.artist_id and event.artist_id == user.id
    if not (is_organizer or is_artist):
        raise HTTPException(status_code=403, detail="아티스트 메시지 작성 권한이 없습니다")


# ── POST /events/{event_id}/artist-messages ──────────────────────────────

@router.post("/{event_id}/artist-messages", response_model=ArtistMessageResponse, status_code=201)
async def create_artist_message(
    event_id: uuid.UUID,
    data: ArtistMessageCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new artist/organizer message on an event page."""
    event_result = await db.execute(select(Event).where(Event.id == event_id))
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="행사를 찾을 수 없습니다")

    _check_event_permission(user, event)

    message = ArtistMessage(
        event_id=event_id,
        author_id=user.id,
        author_name=data.author_name,
        author_avatar_url=data.author_avatar_url,
        content=sanitize_plain_text(data.content),
    )
    db.add(message)
    await db.commit()
    await db.refresh(message)

    return ArtistMessageResponse(
        id=message.id,
        event_id=message.event_id,
        author_id=message.author_id,
        author_name=message.author_name,
        author_avatar_url=message.author_avatar_url,
        content=message.content,
        pinned=message.pinned,
        reactions=message.reactions or {},
        created_at=message.created_at,
    )


# ── GET /events/{event_id}/artist-messages ───────────────────────────────

@router.get("/{event_id}/artist-messages", response_model=ArtistMessageListResponse)
async def list_artist_messages(
    event_id: uuid.UUID,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_read_db),
):
    """List artist messages for an event (public). Pinned first, then newest.

    Paginated (default 50, max 100) to avoid an unbounded scan on events with
    many messages. ``total`` reflects the full count regardless of the page.
    """
    # Verify event exists
    event_exists = await db.execute(select(Event.id).where(Event.id == event_id))
    if not event_exists.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="행사를 찾을 수 없습니다")

    query = (
        select(ArtistMessage)
        .where(ArtistMessage.event_id == event_id)
        .order_by(ArtistMessage.pinned.desc(), ArtistMessage.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    result = await db.execute(query)
    messages = result.scalars().all()

    count_q = select(func.count()).select_from(
        select(ArtistMessage.id).where(ArtistMessage.event_id == event_id).subquery()
    )
    total = await db.scalar(count_q) or 0

    items = [
        ArtistMessageResponse(
            id=m.id,
            event_id=m.event_id,
            author_id=m.author_id,
            author_name=m.author_name,
            author_avatar_url=m.author_avatar_url,
            content=m.content,
            pinned=m.pinned,
            reactions=m.reactions or {},
            created_at=m.created_at,
        )
        for m in messages
    ]

    return ArtistMessageListResponse(items=items, total=total)


# ── PATCH /artist-messages/{message_id}/pin ──────────────────────────────

@router.patch("/artist-messages/{message_id}/pin", response_model=ArtistMessageResponse)
async def toggle_pin(
    message_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Toggle pin status of an artist message."""
    result = await db.execute(select(ArtistMessage).where(ArtistMessage.id == message_id))
    message = result.scalar_one_or_none()
    if not message:
        raise HTTPException(status_code=404, detail="메시지를 찾을 수 없습니다")

    # Permission check via event
    event_result = await db.execute(select(Event).where(Event.id == message.event_id))
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="행사를 찾을 수 없습니다")
    _check_event_permission(user, event)

    message.pinned = not message.pinned
    await db.commit()
    await db.refresh(message)

    return ArtistMessageResponse(
        id=message.id,
        event_id=message.event_id,
        author_id=message.author_id,
        author_name=message.author_name,
        author_avatar_url=message.author_avatar_url,
        content=message.content,
        pinned=message.pinned,
        reactions=message.reactions or {},
        created_at=message.created_at,
    )


# ── DELETE /artist-messages/{message_id} ─────────────────────────────────

@router.delete("/artist-messages/{message_id}", status_code=204)
async def delete_artist_message(
    message_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete an artist message."""
    result = await db.execute(select(ArtistMessage).where(ArtistMessage.id == message_id))
    message = result.scalar_one_or_none()
    if not message:
        raise HTTPException(status_code=404, detail="메시지를 찾을 수 없습니다")

    # Permission check via event
    event_result = await db.execute(select(Event).where(Event.id == message.event_id))
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="행사를 찾을 수 없습니다")
    _check_event_permission(user, event)

    await db.delete(message)
    await db.commit()


# ── POST /artist-messages/{message_id}/react ─────────────────────────────

@router.post("/artist-messages/{message_id}/react")
async def toggle_reaction(
    message_id: uuid.UUID,
    data: ReactionRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add or remove a reaction (emoji) on an artist message."""
    result = await db.execute(select(ArtistMessage).where(ArtistMessage.id == message_id))
    message = result.scalar_one_or_none()
    if not message:
        raise HTTPException(status_code=404, detail="메시지를 찾을 수 없습니다")

    reactions: dict = dict(message.reactions or {})
    emoji = data.emoji
    user_id_str = str(user.id)

    # reactions structure: {"❤️": ["user_id_1", "user_id_2"], "🔥": [...]}
    if emoji not in reactions:
        reactions[emoji] = [user_id_str]
    elif user_id_str in reactions[emoji]:
        reactions[emoji].remove(user_id_str)
        if not reactions[emoji]:
            del reactions[emoji]
    else:
        reactions[emoji].append(user_id_str)

    message.reactions = reactions
    await db.commit()
    await db.refresh(message)

    return {"reactions": message.reactions}
