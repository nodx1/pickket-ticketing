"""
Seat Assigner + Group Tickets Tests
=====================================
Validates seat assignment strategies (PRICE, WEIGHT, RANDOM, FCFS),
adjacent-seat finding, group ticket validation, cross-group checks,
and group/individual splitting.
"""

import pytest

from talkfile_engine.seat_assigner import (
    SeatInfo,
    AssignmentStrategy,
    assign_seats,
    find_adjacent_seats,
)
from talkfile_engine.group_tickets import (
    GroupRequest,
    GroupResult,
    validate_no_cross_group,
    split_groups_and_individuals,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_seats(section: str, row: int, numbers: list[int],
                tier_id: str = "tier-A", quality_base: float = 1.0) -> list[SeatInfo]:
    """Create a list of SeatInfo for one row with decreasing quality."""
    return [
        SeatInfo(
            seat_id=f"{section}-R{row}-S{n}",
            section=section,
            row=row,
            number=n,
            tier_id=tier_id,
            quality_score=quality_base - (n * 0.01),
        )
        for n in numbers
    ]


def _flat_seats() -> list[SeatInfo]:
    """Standard test venue: 2 rows of 5 seats each in section A."""
    seats = _make_seats("A", 1, [1, 2, 3, 4, 5], quality_base=1.0)
    seats += _make_seats("A", 2, [1, 2, 3, 4, 5], quality_base=0.8)
    return seats


# ===========================================================================
# Seat assignment strategies
# ===========================================================================

class TestAssignSeatsPricePriority:
    """PRICE_PRIORITY: higher price -> higher quality seat."""

    def test_higher_price_gets_better_seat(self):
        seats = _flat_seats()
        winners = [("u1", 50.0), ("u2", 100.0), ("u3", 75.0)]
        result = assign_seats(winners, seats, AssignmentStrategy.PRICE_PRIORITY)

        # u2 (100) should get the best seat, u3 (75) second, u1 (50) third
        assert "u2" in result
        assert "u3" in result
        assert "u1" in result
        # Best seat (highest quality_score) is A-R1-S1 (quality 0.99)
        assert result["u2"] == ["A-R1-S1"]
        assert result["u3"] == ["A-R1-S2"]
        assert result["u1"] == ["A-R1-S3"]

    def test_all_winners_assigned(self):
        seats = _flat_seats()
        winners = [("u1", 10.0), ("u2", 20.0)]
        result = assign_seats(winners, seats, AssignmentStrategy.PRICE_PRIORITY)
        assert len(result) == 2


class TestAssignSeatsWeightPriority:
    """WEIGHT_PRIORITY: higher weight -> higher quality seat."""

    def test_higher_weight_gets_better_seat(self):
        seats = _flat_seats()
        winners = [("u1", 0.3), ("u2", 0.9), ("u3", 0.6)]
        result = assign_seats(winners, seats, AssignmentStrategy.WEIGHT_PRIORITY)

        # u2 (0.9) best seat, u3 (0.6) second, u1 (0.3) third
        assert result["u2"] == ["A-R1-S1"]
        assert result["u3"] == ["A-R1-S2"]
        assert result["u1"] == ["A-R1-S3"]


class TestAssignSeatsRandom:
    """RANDOM: different seed -> different assignment."""

    def test_different_seeds_produce_different_orders(self):
        seats = _flat_seats()
        winners = [(f"u{i}", 1.0) for i in range(8)]

        result_a = assign_seats(winners, seats, AssignmentStrategy.RANDOM, rng_seed=42)
        result_b = assign_seats(winners, seats, AssignmentStrategy.RANDOM, rng_seed=999)

        # With 8 winners and different seeds, assignments should differ
        seats_a = [result_a[f"u{i}"][0] for i in range(8)]
        seats_b = [result_b[f"u{i}"][0] for i in range(8)]
        assert seats_a != seats_b

    def test_same_seed_is_deterministic(self):
        seats = _flat_seats()
        winners = [(f"u{i}", 1.0) for i in range(5)]

        result_a = assign_seats(winners, seats, AssignmentStrategy.RANDOM, rng_seed=42)
        result_b = assign_seats(winners, seats, AssignmentStrategy.RANDOM, rng_seed=42)
        assert result_a == result_b


class TestAssignSeatsFCFS:
    """FCFS_ORDER: preserves original order (sorted by score ascending)."""

    def test_fcfs_preserves_order(self):
        seats = _flat_seats()
        # Score represents order index: lower = earlier
        winners = [("u_first", 1.0), ("u_second", 2.0), ("u_third", 3.0)]
        result = assign_seats(winners, seats, AssignmentStrategy.FCFS_ORDER)

        # u_first (score 1) should get the best seat since FCFS sorts ascending
        assert result["u_first"] == ["A-R1-S1"]
        assert result["u_second"] == ["A-R1-S2"]
        assert result["u_third"] == ["A-R1-S3"]


# ===========================================================================
# find_adjacent_seats
# ===========================================================================

class TestFindAdjacentSeats:
    """Test adjacent seat finder."""

    def test_finds_consecutive_in_row(self):
        seats = _make_seats("A", 1, [1, 2, 3, 4, 5])
        result = find_adjacent_seats(seats, 3)
        assert result is not None
        assert len(result) == 3
        # Should be consecutive
        assert result == ["A-R1-S1", "A-R1-S2", "A-R1-S3"]

    def test_finds_adjacent_with_gap(self):
        """Seats 1,2,4,5 -- group of 2 should find 1,2 or 4,5."""
        seats = _make_seats("A", 1, [1, 2, 4, 5])
        result = find_adjacent_seats(seats, 2)
        assert result is not None
        assert len(result) == 2
        # First consecutive pair found: 1,2
        assert result == ["A-R1-S1", "A-R1-S2"]

    def test_returns_none_when_no_adjacent(self):
        """Seats 1, 3, 5 -- no pair of consecutive seats."""
        seats = _make_seats("A", 1, [1, 3, 5])
        result = find_adjacent_seats(seats, 2)
        assert result is None

    def test_returns_none_not_enough_seats(self):
        seats = _make_seats("A", 1, [1, 2])
        result = find_adjacent_seats(seats, 5)
        assert result is None

    def test_zero_group_size_returns_none(self):
        seats = _make_seats("A", 1, [1, 2, 3])
        assert find_adjacent_seats(seats, 0) is None

    def test_adjacent_across_rows_not_returned(self):
        """Seats in different rows should not be considered adjacent."""
        seats = _make_seats("A", 1, [4, 5]) + _make_seats("A", 2, [1, 2])
        result = find_adjacent_seats(seats, 3)
        assert result is None


# ===========================================================================
# Groups assigned adjacent first, then individuals
# ===========================================================================

class TestGroupThenIndividualAssignment:
    """Groups get adjacent seats first; remaining seats go to individuals."""

    def test_group_gets_adjacent_individuals_fill_rest(self):
        seats = _flat_seats()  # 10 seats total
        winners = [("u1", 50.0), ("u2", 60.0), ("u3", 70.0), ("u4", 40.0)]
        groups = {"g1": ["u1", "u2"]}

        result = assign_seats(
            winners, seats, AssignmentStrategy.PRICE_PRIORITY, groups=groups,
        )

        # Group members should have adjacent seats
        u1_seat = result["u1"][0]
        u2_seat = result["u2"][0]
        # Both in same row
        assert u1_seat.startswith("A-R") and u2_seat.startswith("A-R")
        # Individuals u3 and u4 should also be assigned
        assert "u3" in result
        assert "u4" in result


# ===========================================================================
# GroupRequest validation
# ===========================================================================

class TestGroupRequestValidate:
    """Test GroupRequest.validate()."""

    def test_valid_group(self):
        g = GroupRequest(
            group_id="g1", leader_user_id="u1",
            member_user_ids=["u1", "u2", "u3"],
        )
        ok, reason = g.validate(max_group_size=4)
        assert ok is True
        assert reason == "Valid"

    def test_too_small_group(self):
        g = GroupRequest(
            group_id="g1", leader_user_id="u1",
            member_user_ids=["u1"],
        )
        ok, reason = g.validate()
        assert ok is False
        assert "at least 2" in reason

    def test_too_large_group(self):
        g = GroupRequest(
            group_id="g1", leader_user_id="u1",
            member_user_ids=["u1", "u2", "u3", "u4", "u5"],
        )
        ok, reason = g.validate(max_group_size=4)
        assert ok is False
        assert "exceeds max" in reason

    def test_leader_not_in_members(self):
        g = GroupRequest(
            group_id="g1", leader_user_id="u_leader",
            member_user_ids=["u1", "u2"],
        )
        ok, reason = g.validate()
        assert ok is False
        assert "leader must be in member_user_ids" in reason

    def test_duplicate_members(self):
        g = GroupRequest(
            group_id="g1", leader_user_id="u1",
            member_user_ids=["u1", "u2", "u2"],
        )
        ok, reason = g.validate()
        assert ok is False
        assert "Duplicate" in reason

    def test_empty_group_id(self):
        g = GroupRequest(
            group_id="", leader_user_id="u1",
            member_user_ids=["u1", "u2"],
        )
        ok, reason = g.validate()
        assert ok is False
        assert "group_id is required" in reason

    def test_empty_leader(self):
        g = GroupRequest(
            group_id="g1", leader_user_id="",
            member_user_ids=["u1", "u2"],
        )
        ok, reason = g.validate()
        assert ok is False
        assert "leader_user_id is required" in reason

    def test_size_property(self):
        g = GroupRequest(
            group_id="g1", leader_user_id="u1",
            member_user_ids=["u1", "u2", "u3"],
        )
        assert g.size == 3


# ===========================================================================
# Cross-group validation
# ===========================================================================

class TestValidateNoCrossGroup:
    """Test validate_no_cross_group()."""

    def test_no_overlap(self):
        groups = [
            GroupRequest(group_id="g1", leader_user_id="u1", member_user_ids=["u1", "u2"]),
            GroupRequest(group_id="g2", leader_user_id="u3", member_user_ids=["u3", "u4"]),
        ]
        ok, reason = validate_no_cross_group(groups)
        assert ok is True

    def test_overlap_detected(self):
        groups = [
            GroupRequest(group_id="g1", leader_user_id="u1", member_user_ids=["u1", "u2"]),
            GroupRequest(group_id="g2", leader_user_id="u2", member_user_ids=["u2", "u3"]),
        ]
        ok, reason = validate_no_cross_group(groups)
        assert ok is False
        assert "u2" in reason
        assert "g1" in reason and "g2" in reason


# ===========================================================================
# Split groups and individuals
# ===========================================================================

class TestSplitGroupsAndIndividuals:
    """Test split_groups_and_individuals()."""

    def test_correct_separation(self):
        groups = [
            GroupRequest(group_id="g1", leader_user_id="u1", member_user_ids=["u1", "u2"]),
        ]
        all_users = ["u1", "u2", "u3", "u4"]
        returned_groups, individuals = split_groups_and_individuals(all_users, groups)

        assert returned_groups == groups
        assert set(individuals) == {"u3", "u4"}

    def test_all_in_groups(self):
        groups = [
            GroupRequest(group_id="g1", leader_user_id="u1", member_user_ids=["u1", "u2"]),
        ]
        all_users = ["u1", "u2"]
        _, individuals = split_groups_and_individuals(all_users, groups)
        assert individuals == []

    def test_no_groups(self):
        all_users = ["u1", "u2", "u3"]
        _, individuals = split_groups_and_individuals(all_users, [])
        assert individuals == ["u1", "u2", "u3"]


# ===========================================================================
# Edge cases
# ===========================================================================

class TestEdgeCases:
    """Edge cases for assign_seats."""

    def test_empty_winners_returns_empty(self):
        seats = _flat_seats()
        assert assign_seats([], seats, AssignmentStrategy.PRICE_PRIORITY) == {}

    def test_empty_seats_returns_empty(self):
        winners = [("u1", 100.0)]
        assert assign_seats(winners, [], AssignmentStrategy.PRICE_PRIORITY) == {}

    def test_more_winners_than_seats(self):
        seats = _make_seats("A", 1, [1, 2])  # only 2 seats
        winners = [(f"u{i}", float(i)) for i in range(5)]
        result = assign_seats(winners, seats, AssignmentStrategy.PRICE_PRIORITY)
        assert len(result) == 2
