"""
RISE Seat Assigner
===================
Assigns specific seats to winners based on priority strategy.

Strategies:
  - PRICE_PRIORITY: Higher price → better seat (VCG)
  - WEIGHT_PRIORITY: Higher fan weight → better seat (Fanclub)
  - RANDOM: Random assignment (Lottery)
  - FCFS_ORDER: Purchase order (FCFS, Dutch)

Seat quality is determined by quality_score (0-1, higher = better).
Groups are assigned adjacent seats first, then individuals fill remaining.
"""

from dataclasses import dataclass
from enum import Enum


@dataclass
class SeatInfo:
    """Information about a single seat."""
    seat_id: str
    section: str
    row: int
    number: int
    tier_id: str
    quality_score: float = 0.0


class AssignmentStrategy(Enum):
    PRICE_PRIORITY = "price_priority"
    WEIGHT_PRIORITY = "weight_priority"
    RANDOM = "random"
    FCFS_ORDER = "fcfs_order"


def find_adjacent_seats(
    available_seats: list[SeatInfo],
    group_size: int,
) -> list[str] | None:
    """
    Find adjacent seats in the same row for a group.
    Returns seat_ids if found, None otherwise.
    """
    if group_size <= 0:
        return None
    if len(available_seats) < group_size:
        return None

    # Group by (section, row)
    by_row: dict[tuple[str, int], list[SeatInfo]] = {}
    for seat in available_seats:
        key = (seat.section, seat.row)
        if key not in by_row:
            by_row[key] = []
        by_row[key].append(seat)

    # Sort each row by seat number, find consecutive run
    for key in sorted(by_row.keys()):
        row_seats = sorted(by_row[key], key=lambda s: s.number)
        if len(row_seats) < group_size:
            continue

        # Sliding window for consecutive seats
        for i in range(len(row_seats) - group_size + 1):
            window = row_seats[i:i + group_size]
            # Check if numbers are consecutive
            numbers = [s.number for s in window]
            if numbers[-1] - numbers[0] == group_size - 1:
                return [s.seat_id for s in window]

    return None


def assign_seats(
    winners: list[tuple[str, float]],
    available_seats: list[SeatInfo],
    strategy: AssignmentStrategy,
    groups: dict[str, list[str]] | None = None,
    rng_seed: int | None = None,
) -> dict[str, list[str]]:
    """
    Assign seats to winners based on strategy.

    Args:
        winners: List of (user_id, priority_score) tuples
        available_seats: Available seats sorted by quality
        strategy: Assignment strategy
        groups: {group_id: [user_ids]} for group assignments
        rng_seed: Random seed for RANDOM strategy

    Returns:
        {user_id: [seat_ids]} mapping
    """
    if not winners or not available_seats:
        return {}

    result: dict[str, list[str]] = {}
    remaining_seats = list(available_seats)

    # Sort seats by quality (best first)
    remaining_seats.sort(key=lambda s: s.quality_score, reverse=True)

    # Sort winners by priority
    if strategy == AssignmentStrategy.RANDOM:
        import random
        rng = random.Random(rng_seed)
        shuffled = list(winners)
        rng.shuffle(shuffled)
        sorted_winners = shuffled
    elif strategy in (AssignmentStrategy.PRICE_PRIORITY, AssignmentStrategy.WEIGHT_PRIORITY):
        # Higher score = higher priority = better seats
        sorted_winners = sorted(winners, key=lambda x: x[1], reverse=True)
    else:
        # FCFS_ORDER: maintain original order (score = timestamp or order index)
        sorted_winners = sorted(winners, key=lambda x: x[1])

    # Phase 1: Assign groups (adjacent seats)
    assigned_users: set[str] = set()
    if groups:
        for group_id, member_ids in groups.items():
            group_size = len(member_ids)
            adjacent = find_adjacent_seats(remaining_seats, group_size)
            if adjacent:
                # Assign adjacent seats to group members
                for i, uid in enumerate(member_ids):
                    result[uid] = [adjacent[i]]
                    assigned_users.add(uid)
                # Remove assigned seats
                adjacent_set = set(adjacent)
                remaining_seats = [s for s in remaining_seats if s.seat_id not in adjacent_set]

    # Phase 2: Assign individuals
    seat_idx = 0
    for user_id, _ in sorted_winners:
        if user_id in assigned_users:
            continue
        if seat_idx >= len(remaining_seats):
            break
        result[user_id] = [remaining_seats[seat_idx].seat_id]
        seat_idx += 1

    return result
