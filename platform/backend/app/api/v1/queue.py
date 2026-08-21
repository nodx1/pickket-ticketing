"""Queue (대기열) API endpoints for high-traffic ticket sales."""

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.internal_commerce import _internal_auth
from app.core.database import get_db
from app.core.feature_gate import ensure_queue_enabled
from app.middleware.auth import get_current_user
from app.middleware.metrics import QUEUE_JOIN_TOTAL
from app.models.user import User
from app.models.event import Event, EventStatus
from app.services.queue_service import QueueService

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(ensure_queue_enabled)])
internal_router = APIRouter(dependencies=[Depends(_internal_auth)])

_SESSION_TOKEN_PATTERN = r"^[A-Za-z0-9_-]+$"


class QueueJoinResponse(BaseModel):
    position: int
    total_waiting: int
    is_active: bool
    estimated_wait_seconds: int
    token: str | None = None
    message: str


class QueueStatusResponse(BaseModel):
    position: int
    total_waiting: int
    is_active: bool
    estimated_wait_seconds: int
    token: str | None = None


class QueueStatsResponse(BaseModel):
    total_waiting: int
    active_count: int
    max_active: int


class InternalQueueSessionRequest(BaseModel):
    session_token: str = Field(
        min_length=16,
        max_length=128,
        pattern=_SESSION_TOKEN_PATTERN,
    )


class InternalQueueJoinRequest(InternalQueueSessionRequest):
    max_concurrent: int = Field(ge=1, le=10_000)


class InternalQueueConsumeRequest(InternalQueueSessionRequest):
    access_token: str = Field(
        min_length=16,
        max_length=128,
        pattern=_SESSION_TOKEN_PATTERN,
    )
    purchase_key: str = Field(min_length=16, max_length=200)


def _get_queue_or_503(event_id: uuid.UUID) -> QueueService:
    try:
        return QueueService(event_id)
    except RuntimeError as exc:
        raise HTTPException(503, "Queue service temporarily unavailable") from exc


async def _require_internal_event(db: AsyncSession, event_id: uuid.UUID) -> None:
    exists = (
        await db.execute(select(Event.id).where(Event.id == event_id))
    ).scalar_one_or_none()
    if exists is None:
        raise HTTPException(404, "Event not found")


def _status_response(status) -> QueueStatusResponse:
    return QueueStatusResponse(
        position=status.position,
        total_waiting=status.total_waiting,
        is_active=status.is_active,
        estimated_wait_seconds=status.estimated_wait_seconds,
        token=status.token,
    )


def _raise_internal_queue_unavailable(
    operation: str,
    event_id: uuid.UUID,
    exc: Exception,
) -> None:
    logger.warning(
        "Internal queue %s failed (event=%s): %s",
        operation,
        event_id,
        exc,
    )
    raise HTTPException(
        503,
        "Queue service temporarily unavailable. Please try again shortly.",
    ) from exc


@internal_router.post(
    "/events/{event_id}/queue/join",
    response_model=QueueStatusResponse,
)
async def internal_join_queue(
    event_id: uuid.UUID,
    body: InternalQueueJoinRequest,
    db: AsyncSession = Depends(get_db),
):
    """Join the v2 queue with an anonymous go-issued session token.

    Deliberately does not enforce ``BIDDING_OPEN``: the go public route owns
    the queue_enabled policy during Level2 transition. Event existence is
    still checked against the v2 canonical ID to prevent arbitrary Redis
    namespaces from being created by an internal caller.
    """
    await _require_internal_event(db, event_id)
    queue = _get_queue_or_503(event_id)
    try:
        await queue.configure_max_active(body.max_concurrent)
        status = await queue.join(body.session_token)
    except Exception as exc:
        _raise_internal_queue_unavailable("join", event_id, exc)
    return _status_response(status)


@internal_router.get(
    "/events/{event_id}/queue/status",
    response_model=QueueStatusResponse,
)
async def internal_queue_status(
    event_id: uuid.UUID,
    session_token: Annotated[
        str,
        Query(
            min_length=16,
            max_length=128,
            pattern=_SESSION_TOKEN_PATTERN,
        ),
    ],
    response: Response,
):
    """Read an anonymous session's event-scoped queue position."""
    queue = _get_queue_or_503(event_id)
    try:
        status = await queue.get_status(session_token)
    except Exception as exc:
        _raise_internal_queue_unavailable("status", event_id, exc)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return _status_response(status)


@internal_router.post("/events/{event_id}/queue/leave")
async def internal_leave_queue(
    event_id: uuid.UUID,
    body: InternalQueueSessionRequest,
):
    """Release an anonymous session without touching the legacy go DB."""
    queue = _get_queue_or_503(event_id)
    try:
        removed = await queue.leave(body.session_token)
    except Exception as exc:
        _raise_internal_queue_unavailable("leave", event_id, exc)
    return {"success": removed}


@internal_router.post("/events/{event_id}/queue/consume")
async def internal_consume_queue_admission(
    event_id: uuid.UUID,
    body: InternalQueueConsumeRequest,
    db: AsyncSession = Depends(get_db),
):
    """Consume an anonymous admission and bind it to one checkout retry key."""
    await _require_internal_event(db, event_id)
    queue = _get_queue_or_503(event_id)
    try:
        accepted, replayed = await queue.consume_admission(
            body.session_token,
            body.access_token,
            body.purchase_key,
        )
    except ValueError as exc:
        raise HTTPException(403, str(exc)) from exc
    except Exception as exc:
        _raise_internal_queue_unavailable("consume", event_id, exc)
    if not accepted:
        raise HTTPException(403, "Queue admission is missing or expired")
    return {"accepted": True, "replayed": replayed}


@router.post("/{event_id}/queue/join", response_model=QueueJoinResponse)
async def join_queue(
    event_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Join the purchase queue for an event."""
    # Validate event exists and is open
    result = await db.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(404, "Event not found")
    if event.status != EventStatus.BIDDING_OPEN:
        raise HTTPException(400, "Event is not open for sales")

    queue = _get_queue_or_503(event_id)
    try:
        status = await queue.join(current_user.id)
    except (ConnectionError, TimeoutError, OSError) as exc:
        logger.warning("Redis unavailable for queue join (event=%s): %s", event_id, exc)
        try:
            QUEUE_JOIN_TOTAL.labels(result="failed").inc()
        except Exception:
            logger.debug("queue metric recording failed", exc_info=True)
        raise HTTPException(
            503, "Queue service temporarily unavailable. Please try again shortly."
        ) from exc

    try:
        QUEUE_JOIN_TOTAL.labels(result="success").inc()
    except Exception:
        logger.debug("queue metric recording failed", exc_info=True)

    if status.is_active:
        message = "Proceed to purchase page"
    else:
        message = f"Queue position: #{status.position} (est. {status.estimated_wait_seconds}s)"

    return QueueJoinResponse(
        position=status.position,
        total_waiting=status.total_waiting,
        is_active=status.is_active,
        estimated_wait_seconds=status.estimated_wait_seconds,
        token=status.token,
        message=message,
    )


@router.get("/{event_id}/queue/status", response_model=QueueStatusResponse)
async def queue_status(
    event_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    response: Response = None,
):
    """Check current position in queue."""
    queue = _get_queue_or_503(event_id)
    try:
        status = await queue.get_status(current_user.id)
    except (ConnectionError, TimeoutError, OSError) as exc:
        logger.warning("Redis unavailable for queue status (event=%s): %s", event_id, exc)
        raise HTTPException(
            503, "Queue service temporarily unavailable. Please try again shortly."
        ) from exc

    if response:
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"

    return QueueStatusResponse(
        position=status.position,
        total_waiting=status.total_waiting,
        is_active=status.is_active,
        estimated_wait_seconds=status.estimated_wait_seconds,
        token=status.token,
    )


@router.post("/{event_id}/queue/leave")
async def leave_queue(
    event_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
):
    """Voluntarily leave the queue."""
    queue = _get_queue_or_503(event_id)
    try:
        removed = await queue.leave(current_user.id)
    except (ConnectionError, TimeoutError, OSError) as exc:
        logger.warning("Redis unavailable for queue leave (event=%s): %s", event_id, exc)
        raise HTTPException(
            503, "Queue service temporarily unavailable. Please try again shortly."
        ) from exc
    return {
        "success": removed,
        "message": "Left the queue" if removed else "Not in queue",
    }


@router.get("/{event_id}/queue/stats", response_model=QueueStatsResponse)
async def queue_stats(event_id: uuid.UUID):
    """Public queue stats (no auth required)."""
    queue = _get_queue_or_503(event_id)
    try:
        stats = await queue.get_stats()
    except (ConnectionError, TimeoutError, OSError) as exc:
        logger.warning("Redis unavailable for queue stats (event=%s): %s", event_id, exc)
        raise HTTPException(
            503, "Queue service temporarily unavailable. Please try again shortly."
        ) from exc
    return QueueStatsResponse(
        total_waiting=stats.total_waiting,
        active_count=stats.active_count,
        max_active=stats.max_active,
    )
