"""Seat selection, hold, and release endpoints."""

import logging
import uuid
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.redis import redis_lock
from app.middleware.auth import get_current_user, get_current_user_optional
from app.models.user import User
from app.models.seat import SeatStatus
from app.repositories.seat_repo import SeatRepository
from app.schemas.seat import SeatResponse, SeatPublicResponse, SeatHoldRequest, SeatHoldResponse
from app.services.queue_service import QueueService

router = APIRouter()
logger = logging.getLogger(__name__)

HOLD_DURATION_MINUTES = 10


@router.get("/{event_id}/seats")
async def list_seats(
    event_id: uuid.UUID,
    section: str | None = Query(None),
    tier_id: uuid.UUID | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user_optional),
) -> list[SeatResponse] | list[SeatPublicResponse]:
    """Get all seats for an event.

    큐 토큰을 보유한 인증 유저에게만 seat_id(UUID) 노출.
    미인증 또는 토큰 없는 유저는 좌표/상태만 조회 가능 (Shadow Reading 차단).
    """
    repo = SeatRepository(db)
    await repo.cleanup_expired_holds(event_id)
    await db.commit()
    seats = await repo.get_by_event(event_id, section=section, tier_id=tier_id)

    # 큐 토큰 보유 여부로 seat_id 노출 결정
    has_token = False
    if user:
        try:
            queue = QueueService(event_id)
            has_token = await queue.validate_token(user.id)
        except Exception:
            logger.debug("queue token validation failed for seat check", exc_info=True)

    if has_token:
        return [SeatResponse.model_validate(s) for s in seats]
    return [SeatPublicResponse.model_validate(s) for s in seats]


@router.post(
    "/{event_id}/seats/hold",
    response_model=SeatHoldResponse,
    status_code=status.HTTP_201_CREATED,
)
async def hold_seats(
    event_id: uuid.UUID,
    data: SeatHoldRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Hold seats for a user. Max 4 seats, 10 minute hold.

    Acquires a distributed Redis lock per event to prevent race conditions.
    """
    try:
        async with redis_lock(f"v2:event:{{{event_id}}}:seats:hold", ttl=5):
            repo = SeatRepository(db)
            # C4: Proactively clean up expired holds before checking availability
            await repo.cleanup_expired_holds(event_id)
            hold_until = datetime.now(timezone.utc) + timedelta(minutes=HOLD_DURATION_MINUTES)

            # Verify all seats belong to this event and are available.
            # 같은 사용자가 자기 hold 를 재시도하는 건 허용 (새로고침/뒤로가기 등).
            for sid in data.seat_ids:
                seat = await repo.get(sid)
                if not seat:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail=f"Seat {sid} not found",
                    )
                if seat.event_id != event_id:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Seat {sid} does not belong to event {event_id}",
                    )
                if seat.status == SeatStatus.AVAILABLE:
                    continue
                # 내가 이미 홀드한 좌석이면 갱신 허용 — held_by 일치 && held_until 미경과
                if (
                    seat.status == SeatStatus.HELD
                    and seat.held_by == user.id
                    and seat.held_until
                    and seat.held_until > datetime.now(timezone.utc)
                ):
                    continue
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"Seat {sid} is not available (status: {seat.status})",
                )

            hold_id = uuid.uuid4()
            held_ids = await repo.hold_seats(data.seat_ids, user.id, hold_until, hold_id=hold_id)
            await db.commit()

            return SeatHoldResponse(
                success=True,
                held_seat_ids=held_ids,
                hold_id=hold_id,
                held_until=hold_until,
                message=f"Successfully held {len(held_ids)} seat(s) for {HOLD_DURATION_MINUTES} minutes",
            )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="좌석 선점에 실패했습니다. 이미 선택된 좌석일 수 있습니다.",
        ) from exc
    except TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Server busy, please retry",
        )


@router.delete("/{event_id}/seats/hold", response_model=SeatHoldResponse)
async def release_seats(
    event_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Release all seats held by the current user for this event."""
    repo = SeatRepository(db)
    # H6: Use optimized direct query instead of loading all event seats
    released_ids = await repo.release_holds_by_user(event_id, user.id)
    await db.commit()

    if not released_ids:
        return SeatHoldResponse(
            success=True,
            held_seat_ids=[],
            message="No seats held by user",
        )

    return SeatHoldResponse(
        success=True,
        held_seat_ids=released_ids,
        message=f"Released {len(released_ids)} seat(s)",
    )


@router.delete("/{event_id}/seats/hold/{hold_id}")
async def release_hold_by_id(
    event_id: uuid.UUID,
    hold_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    repo = SeatRepository(db)
    released = await repo.release_by_hold_id(hold_id, user.id)
    await db.commit()
    return {"success": True, "released_count": released}


@router.get("/{event_id}/seats/best-available")
async def best_available_seats(
    event_id: uuid.UUID,
    tier_id: uuid.UUID = Query(...),
    quantity: int = Query(default=1, ge=1, le=4),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[SeatResponse]:
    """Get best available seats — 인증 + 큐 토큰 필수.

    프리미엄 좌석 추천은 큐를 통과한 유저에게만 제공 (Shadow Reading 차단).
    """
    # 큐 토큰 검증
    try:
        queue = QueueService(event_id)
        has_token = await queue.validate_token(user.id)
    except Exception:
        has_token = False

    if not has_token:
        # 큐 활성 상태인데 토큰 없으면 차단
        try:
            stats = await queue.get_stats()
            if stats.total_waiting > 0 or stats.active_count > 0:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Queue token required to view best available seats",
                )
        except HTTPException:
            raise
        except Exception:
            logger.debug("seat repository initialization failed", exc_info=True)

    repo = SeatRepository(db)
    await repo.cleanup_expired_holds(event_id)
    await db.commit()
    seats = await repo.get_best_available(tier_id, quantity, prefer_adjacent=True)
    return [SeatResponse.model_validate(s) for s in seats]
