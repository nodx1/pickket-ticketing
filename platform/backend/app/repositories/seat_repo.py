import uuid
from datetime import datetime, timezone

from sqlalchemy import select, and_, update
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.seat import Seat, SeatStatus
from app.repositories.base import BaseRepository


class SeatRepository(BaseRepository[Seat]):
    def __init__(self, session: AsyncSession):
        super().__init__(Seat, session)

    async def get_available_by_tier(self, tier_id: uuid.UUID, limit: int = 100) -> list[Seat]:
        result = await self.session.execute(
            select(Seat)
            .where(Seat.tier_id == tier_id, Seat.status == SeatStatus.AVAILABLE)
            .order_by(Seat.quality_score.desc())
            .limit(limit)
        )
        return list(result.scalars().all())

    async def hold_seats(
        self,
        seat_ids: list[uuid.UUID],
        user_id: uuid.UUID,
        until: "datetime",
        hold_id: uuid.UUID | None = None,
    ) -> list[uuid.UUID]:
        held_ids: list[uuid.UUID] = []
        for sid in seat_ids:
            seat = await self.get_for_update(sid)
            if not seat or seat.status != SeatStatus.AVAILABLE:
                raise ValueError(f"Seat {sid} is not available")
            seat.status = SeatStatus.HELD
            seat.held_by = user_id
            seat.held_until = until
            seat.hold_id = hold_id
            held_ids.append(seat.id)
        await self.session.flush()
        return held_ids

    async def mark_sold(self, seat_ids: list[uuid.UUID]) -> None:
        if not seat_ids:
            return
        await self.session.execute(
            update(Seat)
            .where(Seat.id.in_(seat_ids))
            .values(
                status=SeatStatus.SOLD,
                held_by=None,
                held_until=None,
                hold_id=None,
            )
        )
        await self.session.flush()

    async def release_holds(self, seat_ids: list[uuid.UUID]) -> None:
        if not seat_ids:
            return
        await self.session.execute(
            update(Seat)
            .where(Seat.id.in_(seat_ids), Seat.status == SeatStatus.HELD)
            .values(
                status=SeatStatus.AVAILABLE,
                held_by=None,
                held_until=None,
                hold_id=None,
            )
        )
        await self.session.flush()

    async def release_sold(self, seat_ids: list[uuid.UUID]) -> None:
        """환불 시 SOLD 좌석을 AVAILABLE로 복원."""
        if not seat_ids:
            return
        await self.session.execute(
            update(Seat)
            .where(Seat.id.in_(seat_ids), Seat.status == SeatStatus.SOLD)
            .values(
                status=SeatStatus.AVAILABLE,
                held_by=None,
                held_until=None,
                hold_id=None,
            )
        )
        await self.session.flush()

    async def release_holds_by_user(
        self, event_id: uuid.UUID, user_id: uuid.UUID
    ) -> list[uuid.UUID]:
        """Release all seats held by a user for a specific event. Returns list of released seat IDs."""
        # First get the IDs to return
        result = await self.session.execute(
            select(Seat.id).where(
                Seat.event_id == event_id,
                Seat.held_by == user_id,
                Seat.status == SeatStatus.HELD,
            )
        )
        released = [row[0] for row in result.all()]
        if released:
            await self.session.execute(
                update(Seat)
                .where(Seat.id.in_(released))
                .values(
                    status=SeatStatus.AVAILABLE,
                    held_by=None,
                    held_until=None,
                    hold_id=None,
                )
            )
            await self.session.flush()
        return released

    async def release_by_hold_id(self, hold_id: uuid.UUID, user_id: uuid.UUID) -> int:
        result = await self.session.execute(
            update(Seat)
            .where(
                Seat.hold_id == hold_id,
                Seat.held_by == user_id,
                Seat.status == SeatStatus.HELD,
            )
            .values(
                status=SeatStatus.AVAILABLE,
                held_by=None,
                held_until=None,
                hold_id=None,
            )
        )
        await self.session.flush()
        return result.rowcount

    async def get_by_section(
        self,
        event_id: uuid.UUID,
        section: str,
        tier_id: uuid.UUID | None = None,
    ) -> list[Seat]:
        """Get all seats for an event filtered by section, optionally by tier."""
        conditions = [Seat.event_id == event_id, Seat.section == section]
        if tier_id:
            conditions.append(Seat.tier_id == tier_id)
        result = await self.session.execute(
            select(Seat).where(and_(*conditions)).order_by(Seat.row_number, Seat.seat_number)
        )
        return list(result.scalars().all())

    async def get_best_available(
        self,
        tier_id: uuid.UUID,
        quantity: int,
        prefer_adjacent: bool = True,
    ) -> list[Seat]:
        """Get best available seats by quality_score, preferring same-row adjacency."""
        result = await self.session.execute(
            select(Seat)
            .where(
                Seat.tier_id == tier_id,
                Seat.status == SeatStatus.AVAILABLE,
            )
            .order_by(Seat.quality_score.desc())
            .limit(quantity * 3)
        )
        candidates = list(result.scalars().all())

        if not candidates or not prefer_adjacent or quantity <= 1:
            return candidates[:quantity]

        # Try to find adjacent seats in the same row
        rows: dict[tuple[str, int], list[Seat]] = {}
        for seat in candidates:
            key = (seat.section, seat.row_number)
            rows.setdefault(key, []).append(seat)

        best_group: list[Seat] | None = None
        best_score = -1.0

        for key, row_seats in rows.items():
            row_seats.sort(key=lambda s: s.seat_number)
            # Sliding window to find adjacent groups
            for i in range(len(row_seats) - quantity + 1):
                group = row_seats[i : i + quantity]
                # Check adjacency
                is_adjacent = all(
                    group[j + 1].seat_number - group[j].seat_number == 1
                    for j in range(len(group) - 1)
                )
                if is_adjacent:
                    avg_score = sum(s.quality_score for s in group) / len(group)
                    if avg_score > best_score:
                        best_score = avg_score
                        best_group = group

        if best_group:
            return best_group

        # Fallback: return top quality seats regardless of adjacency
        return candidates[:quantity]

    async def verify_hold(self, seat_ids: list[uuid.UUID], user_id: uuid.UUID) -> bool:
        """Check all seats are held by the given user and holds are still valid.

        If a hold is expired, automatically cleans up the seat (sets it back to available).
        """
        now = datetime.now(timezone.utc)
        for sid in seat_ids:
            seat = await self.get_for_update(sid)
            if not seat:
                return False
            if seat.status != SeatStatus.HELD:
                return False
            if seat.held_by != user_id:
                return False
            if seat.held_until and seat.held_until.replace(tzinfo=timezone.utc) < now:
                # Auto-cleanup expired hold
                seat.status = SeatStatus.AVAILABLE
                seat.held_by = None
                seat.held_until = None
                seat.hold_id = None
                return False
        return True

    async def verify_and_mark_sold(self, seat_ids: list[uuid.UUID], user_id: uuid.UUID) -> bool:
        """Verify holds and mark seats as sold in a single pass.

        Combines verify_hold + mark_sold to halve the number of FOR UPDATE queries (2N → N).
        Returns False if any seat fails validation (expired hold, wrong user, etc.).
        """
        now = datetime.now(timezone.utc)
        for sid in seat_ids:
            seat = await self.get_for_update(sid)
            if not seat or seat.status != SeatStatus.HELD or seat.held_by != user_id:
                return False
            if seat.held_until and seat.held_until.replace(tzinfo=timezone.utc) < now:
                seat.status = SeatStatus.AVAILABLE
                seat.held_by = None
                seat.held_until = None
                seat.hold_id = None
                return False
            seat.status = SeatStatus.SOLD
            seat.held_by = None
            seat.held_until = None
            seat.hold_id = None
        await self.session.flush()
        return True

    async def cleanup_expired_holds(self, event_id: uuid.UUID) -> int:
        """Clean up expired holds for an event. Returns count of cleaned holds."""
        now = datetime.now(timezone.utc)
        result = await self.session.execute(
            update(Seat)
            .where(
                Seat.event_id == event_id,
                Seat.status == SeatStatus.HELD,
                Seat.held_until < now,
            )
            .values(
                status=SeatStatus.AVAILABLE,
                held_by=None,
                held_until=None,
                hold_id=None,
            )
        )
        count = result.rowcount
        if count > 0:
            await self.session.flush()
        return count

    async def get_by_event(
        self, event_id: uuid.UUID, section: str | None = None, tier_id: uuid.UUID | None = None
    ) -> list[Seat]:
        """Get all seats for an event, optionally filtered by section and/or tier."""
        conditions = [Seat.event_id == event_id]
        if section:
            conditions.append(Seat.section == section)
        if tier_id:
            conditions.append(Seat.tier_id == tier_id)
        result = await self.session.execute(
            select(Seat)
            .where(and_(*conditions))
            .order_by(Seat.section, Seat.row_number, Seat.seat_number)
        )
        return list(result.scalars().all())
