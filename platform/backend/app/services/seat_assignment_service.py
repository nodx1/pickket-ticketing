"""
Seat Assignment Service
========================
Assigns specific physical seats to ticket winners using engine's seat_assigner.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from talkfile_engine.seat_assigner import (
    AssignmentStrategy,
    SeatInfo,
    assign_seats,
)

from app.repositories.seat_repo import SeatRepository


class SeatAssignmentService:
    """Service for assigning physical seats to ticket winners."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.seat_repo = SeatRepository(session)

    async def assign(
        self,
        tier_id: uuid.UUID,
        winners: list[tuple[str, float]],
        strategy: str = "best_available",
        groups: dict[str, list[str]] | None = None,
        rng_seed: int | None = None,
    ) -> dict[str, list[uuid.UUID]]:
        """
        Assign seats to winners for a given tier.

        Loads available seats from DB, converts to engine SeatInfo,
        calls engine's assign_seats(), marks assigned seats as SOLD.

        Args:
            tier_id: Seat tier UUID.
            winners: List of (user_id_str, priority_score) tuples.
                     priority_score semantics depend on strategy:
                     - PRICE_PRIORITY: final_price (higher = better seat)
                     - WEIGHT_PRIORITY: fan_weight (higher = better seat)
                     - RANDOM: ignored
                     - FCFS_ORDER: timestamp/order index (lower = earlier)
            strategy: One of "best_available", "random", "price_priority",
                     "weight_priority", "fcfs_order".
            groups: Optional {group_id: [user_id_strs]} for adjacent seating.
            rng_seed: Random seed for RANDOM strategy.

        Returns:
            Mapping of user_id string to list of assigned seat UUIDs.
        """
        if not winners:
            return {}

        # Determine how many seats we need
        total_needed = len(winners)
        if groups:
            # Groups already counted in winners list
            pass

        # Load available seats from DB
        db_seats = await self.seat_repo.get_available_by_tier(tier_id, limit=total_needed + 20)
        if not db_seats:
            return {}

        # Convert DB seats to engine SeatInfo
        engine_seats: list[SeatInfo] = []
        seat_uuid_map: dict[str, uuid.UUID] = {}  # seat_id_str -> seat_uuid
        for seat in db_seats:
            seat_id_str = str(seat.id)
            engine_seats.append(
                SeatInfo(
                    seat_id=seat_id_str,
                    section=seat.section,
                    row=seat.row_number,
                    number=seat.seat_number,
                    tier_id=str(seat.tier_id),
                    quality_score=seat.quality_score,
                )
            )
            seat_uuid_map[seat_id_str] = seat.id

        # Map strategy string to enum
        strategy_map = {
            "best_available": AssignmentStrategy.PRICE_PRIORITY,
            "price_priority": AssignmentStrategy.PRICE_PRIORITY,
            "weight_priority": AssignmentStrategy.WEIGHT_PRIORITY,
            "random": AssignmentStrategy.RANDOM,
            "fcfs_order": AssignmentStrategy.FCFS_ORDER,
        }
        engine_strategy = strategy_map.get(strategy, AssignmentStrategy.PRICE_PRIORITY)

        # Call engine
        assignment = assign_seats(
            winners=winners,
            available_seats=engine_seats,
            strategy=engine_strategy,
            groups=groups,
            rng_seed=rng_seed,
        )

        # Mark assigned seats as SOLD in DB
        all_assigned_seat_ids: list[uuid.UUID] = []
        result: dict[str, list[uuid.UUID]] = {}

        for user_id_str, seat_id_strs in assignment.items():
            seat_uuids = []
            for sid_str in seat_id_strs:
                seat_uuid = seat_uuid_map.get(sid_str)
                if seat_uuid:
                    seat_uuids.append(seat_uuid)
                    all_assigned_seat_ids.append(seat_uuid)
            result[user_id_str] = seat_uuids

        if all_assigned_seat_ids:
            await self.seat_repo.mark_sold(all_assigned_seat_ids)

        return result
