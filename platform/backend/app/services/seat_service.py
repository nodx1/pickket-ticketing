"""
Seat Service
=============
Standalone async functions for seat operations triggered by SQS events.
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update

from app.core.database import async_session
from app.models.seat import Seat, SeatStatus

logger = logging.getLogger(__name__)


async def record_seat_hold(
    event_id: str,
    seat_id: str,
    user_id: str,
    hold_ttl: int = 300,
) -> None:
    """Persist a seat hold record from Go ticket-gateway via SQS.

    Updates the seat row to HELD status with expiry. If the seat is already
    held or sold, the update is skipped (idempotent).

    Args:
        event_id: Event UUID string.
        seat_id: Seat UUID string.
        user_id: User UUID string.
        hold_ttl: Hold duration in seconds (default 300 = 5 min).
    """
    seat_uuid = uuid.UUID(seat_id)
    user_uuid = uuid.UUID(user_id)
    held_until = datetime.now(timezone.utc) + timedelta(seconds=hold_ttl)

    async with async_session() as session:
        async with session.begin():
            # Only update if seat is currently AVAILABLE (idempotent)
            result = await session.execute(
                update(Seat)
                .where(
                    Seat.id == seat_uuid,
                    Seat.status == SeatStatus.AVAILABLE,
                )
                .values(
                    status=SeatStatus.HELD,
                    held_by=user_uuid,
                    held_until=held_until,
                )
            )

            if result.rowcount:
                logger.info(
                    "Seat hold recorded: seat=%s user=%s ttl=%ds",
                    seat_id, user_id, hold_ttl,
                )
            else:
                logger.warning(
                    "Seat hold skipped (not available): seat=%s user=%s",
                    seat_id, user_id,
                )


async def release_seat_hold(
    event_id: str,
    seat_id: str,
    user_id: str,
) -> None:
    """Release a seat hold persisted earlier from ticket-gateway events.

    Only HELD seats owned by the same user are released. SOLD seats are left
    untouched so a late release event cannot undo a completed purchase.
    """
    seat_uuid = uuid.UUID(seat_id)
    event_uuid = uuid.UUID(event_id)
    user_uuid = uuid.UUID(user_id)

    async with async_session() as session:
        async with session.begin():
            result = await session.execute(
                update(Seat)
                .where(
                    Seat.id == seat_uuid,
                    Seat.event_id == event_uuid,
                    Seat.status == SeatStatus.HELD,
                    Seat.held_by == user_uuid,
                )
                .values(
                    status=SeatStatus.AVAILABLE,
                    held_by=None,
                    held_until=None,
                )
            )

            if result.rowcount:
                logger.info(
                    "Seat hold released: seat=%s user=%s",
                    seat_id, user_id,
                )
            else:
                logger.info(
                    "Seat release skipped (not held by user or already finalized): seat=%s user=%s",
                    seat_id, user_id,
                )
