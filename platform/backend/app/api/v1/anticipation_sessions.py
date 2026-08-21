"""Anticipation session endpoints -- 같이 기대하기 (fans gather before events)."""

import json
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.redis import get_redis
from app.core.sanitize import sanitize_plain_text
from app.middleware.auth import get_current_user
from app.models.event import Event
from app.models.anticipation_session import AnticipationSession
from app.models.user import User
from app.schemas.anticipation_session import (
    AnticipationSessionCreate,
    AnticipationSessionResponse,
    AnticipationSessionListResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()

ANTICIPATION_CHANNEL_PREFIX = "anticipation:"


def _session_to_response(s: AnticipationSession) -> AnticipationSessionResponse:
    return AnticipationSessionResponse(
        id=s.id,
        event_id=s.event_id,
        title=s.title,
        description=s.description,
        scheduled_at=s.scheduled_at,
        spotify_playlist_url=s.spotify_playlist_url,
        participant_count=s.participant_count,
        created_at=s.created_at,
    )


# ── POST /events/{event_id}/anticipation-sessions ──────────────────────────

@router.post(
    "/{event_id}/anticipation-sessions",
    response_model=AnticipationSessionResponse,
    status_code=201,
)
async def create_anticipation_session(
    event_id: uuid.UUID,
    data: AnticipationSessionCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new anticipation session for an event (organizer/artist only)."""
    event_result = await db.execute(select(Event).where(Event.id == event_id))
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="행사를 찾을 수 없습니다")

    # Permission: only organizer or artist of the event
    is_organizer = event.organizer_id and event.organizer_id == user.id
    is_artist = event.artist_id and event.artist_id == user.id
    if not (is_organizer or is_artist):
        raise HTTPException(status_code=403, detail="기대 세션 생성 권한이 없습니다")

    session = AnticipationSession(
        event_id=event_id,
        title=sanitize_plain_text(data.title),
        description=sanitize_plain_text(data.description) if data.description else None,
        scheduled_at=data.scheduled_at,
        spotify_playlist_url=data.spotify_playlist_url,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    return _session_to_response(session)


# ── GET /events/{event_id}/anticipation-sessions ───────────────────────────

@router.get(
    "/{event_id}/anticipation-sessions",
    response_model=AnticipationSessionListResponse,
)
async def list_anticipation_sessions(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_read_db),
):
    """List anticipation sessions for an event (public)."""
    event_exists = await db.execute(select(Event.id).where(Event.id == event_id))
    if not event_exists.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="행사를 찾을 수 없습니다")

    query = (
        select(AnticipationSession)
        .where(AnticipationSession.event_id == event_id)
        .order_by(AnticipationSession.created_at.desc())
    )
    result = await db.execute(query)
    sessions = result.scalars().all()

    count_q = select(func.count()).select_from(
        select(AnticipationSession.id)
        .where(AnticipationSession.event_id == event_id)
        .subquery()
    )
    total = await db.scalar(count_q) or 0

    return AnticipationSessionListResponse(
        items=[_session_to_response(s) for s in sessions],
        total=total,
    )


# ── GET /anticipation-sessions/{session_id} ────────────────────────────────

@router.get(
    "/{session_id}",
    response_model=AnticipationSessionResponse,
)
async def get_anticipation_session(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_read_db),
):
    """Get a single anticipation session."""
    result = await db.execute(
        select(AnticipationSession).where(AnticipationSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="기대 세션을 찾을 수 없습니다")

    return _session_to_response(session)


# ── POST /anticipation-sessions/{session_id}/join ──────────────────────────

@router.post("/{session_id}/join")
async def join_anticipation_session(
    session_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Join an anticipation session — increments participant count and publishes to Redis."""
    result = await db.execute(
        select(AnticipationSession).where(AnticipationSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="기대 세션을 찾을 수 없습니다")

    session.participant_count = (session.participant_count or 0) + 1
    await db.commit()
    await db.refresh(session)

    new_count = session.participant_count

    # Publish update to Redis SSE channel
    try:
        redis = get_redis()
        channel = f"{ANTICIPATION_CHANNEL_PREFIX}{session_id}"
        await redis.publish(
            channel, json.dumps({"participant_count": new_count})
        )
    except Exception:
        logger.debug("anticipation pubsub failed", exc_info=True)

    return {"participant_count": new_count}
