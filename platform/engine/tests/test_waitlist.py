"""
Waitlist & Reallocation Tests
===============================
Validates priority-ordered waitlist, cancellation reallocation,
payment tracking, expiry logic, and edge cases.
"""

import pytest
from datetime import datetime, timedelta, timezone

from talkfile_engine.waitlist import (
    Waitlist,
    WaitlistEntry,
    PendingPayment,
    ReallocationResult,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TIER = "tier-A"
TIER_B = "tier-B"


def _utc(minutes_offset: int = 0) -> datetime:
    base = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
    return base + timedelta(minutes=minutes_offset)


def _entry(user_id: str, tier_id: str = TIER, priority: float = 50.0,
           group_id: str | None = None, group_size: int = 1,
           quantity: int = 1) -> WaitlistEntry:
    return WaitlistEntry(
        user_id=user_id,
        tier_id=tier_id,
        priority_score=priority,
        group_id=group_id,
        group_size=group_size,
        quantity=quantity,
    )


# ===========================================================================
# add() and get_position()
# ===========================================================================

class TestAddAndPosition:
    """Test adding entries and querying position."""

    def test_single_entry_position_is_one(self):
        wl = Waitlist()
        pos = wl.add(_entry("u1"))
        assert pos == 1

    def test_priority_ordering(self):
        """Higher priority_score -> lower position number (closer to front)."""
        wl = Waitlist()
        wl.add(_entry("u_low", priority=10.0))
        wl.add(_entry("u_high", priority=90.0))
        wl.add(_entry("u_mid", priority=50.0))

        assert wl.get_position("u_high", TIER) == 1
        assert wl.get_position("u_mid", TIER) == 2
        assert wl.get_position("u_low", TIER) == 3

    def test_get_position_not_on_waitlist(self):
        wl = Waitlist()
        wl.add(_entry("u1"))
        assert wl.get_position("u_nonexistent", TIER) is None

    def test_size_reflects_entries(self):
        wl = Waitlist()
        assert wl.size(TIER) == 0
        wl.add(_entry("u1"))
        wl.add(_entry("u2"))
        assert wl.size(TIER) == 2


# ===========================================================================
# remove()
# ===========================================================================

class TestRemove:
    """Test removing users from the waitlist."""

    def test_remove_existing_user(self):
        wl = Waitlist()
        wl.add(_entry("u1"))
        wl.add(_entry("u2"))
        removed = wl.remove("u1", TIER)
        assert removed is True
        assert wl.size(TIER) == 1
        assert wl.get_position("u1", TIER) is None

    def test_remove_nonexistent_user(self):
        wl = Waitlist()
        wl.add(_entry("u1"))
        removed = wl.remove("u_ghost", TIER)
        assert removed is False
        assert wl.size(TIER) == 1


# ===========================================================================
# process_cancellation()
# ===========================================================================

class TestProcessCancellation:
    """Test cancellation reallocation logic."""

    def test_reallocates_to_top_priority(self):
        wl = Waitlist()
        wl.add(_entry("u_low", priority=10.0))
        wl.add(_entry("u_high", priority=90.0))

        results = wl.process_cancellation(TIER, freed_seats=1, cancelled_by="orig", price=50.0)

        assert len(results) == 1
        assert results[0].user_id == "u_high"
        assert results[0].price == 50.0
        assert results[0].original_winner_id == "orig"
        # u_high removed from waitlist
        assert wl.get_position("u_high", TIER) is None
        # u_low still there
        assert wl.get_position("u_low", TIER) == 1

    def test_multiple_seats_reallocated(self):
        wl = Waitlist()
        wl.add(_entry("u1", priority=90.0))
        wl.add(_entry("u2", priority=80.0))
        wl.add(_entry("u3", priority=70.0))

        results = wl.process_cancellation(TIER, freed_seats=2)
        assert len(results) == 2
        user_ids = {r.user_id for r in results}
        assert user_ids == {"u1", "u2"}
        assert wl.size(TIER) == 1

    def test_group_skipped_if_not_enough_seats(self):
        """A group needing 3 seats should be skipped if only 1 seat freed."""
        wl = Waitlist()
        wl.add(_entry("u_group_leader", priority=100.0, group_id="g1", group_size=3))
        wl.add(_entry("u_individual", priority=50.0))

        results = wl.process_cancellation(TIER, freed_seats=1)

        # Group needs 3 but only 1 available -- skip group, allocate individual
        assert len(results) == 1
        assert results[0].user_id == "u_individual"

    def test_cancellation_zero_freed_seats(self):
        wl = Waitlist()
        wl.add(_entry("u1"))
        results = wl.process_cancellation(TIER, freed_seats=0)
        assert results == []

    def test_cancellation_empty_waitlist(self):
        wl = Waitlist()
        results = wl.process_cancellation(TIER, freed_seats=5)
        assert results == []


# ===========================================================================
# Pending payments
# ===========================================================================

class TestPendingPayments:
    """Test add_pending_payment() and mark_paid()."""

    def test_add_and_mark_paid(self):
        wl = Waitlist()
        pending = wl.add_pending_payment("u1", TIER, ["s1", "s2"], price=100.0)
        assert pending.paid is False
        assert pending.user_id == "u1"
        assert len(pending.seat_ids) == 2

        found = wl.mark_paid("u1", TIER)
        assert found is True
        assert pending.paid is True

    def test_mark_paid_nonexistent(self):
        wl = Waitlist()
        found = wl.mark_paid("u_ghost", TIER)
        assert found is False

    def test_mark_paid_idempotence(self):
        """Marking an already-paid entry should return False (no unpaid match)."""
        wl = Waitlist()
        wl.add_pending_payment("u1", TIER, ["s1"], price=50.0)
        wl.mark_paid("u1", TIER)
        # Second call: already paid, not found as unpaid
        assert wl.mark_paid("u1", TIER) is False


# ===========================================================================
# expire_unpaid()
# ===========================================================================

class TestExpireUnpaid:
    """Test expiry of unpaid pending payments."""

    def test_expire_past_deadline(self):
        wl = Waitlist()
        wl.add_pending_payment("u1", TIER, ["s1", "s2"], price=100.0, deadline_minutes=30)
        # Jump 60 minutes into the future
        now = datetime.now(timezone.utc) + timedelta(minutes=60)
        expired = wl.expire_unpaid(now=now)

        assert len(expired) == 1
        user_id, tier_id, freed = expired[0]
        assert user_id == "u1"
        assert tier_id == TIER
        assert freed == 2

    def test_keeps_paid_entries(self):
        wl = Waitlist()
        wl.add_pending_payment("u_paid", TIER, ["s1"], price=50.0, deadline_minutes=30)
        wl.mark_paid("u_paid", TIER)
        wl.add_pending_payment("u_unpaid", TIER, ["s2"], price=50.0, deadline_minutes=30)

        now = datetime.now(timezone.utc) + timedelta(minutes=60)
        expired = wl.expire_unpaid(now=now)

        # Only the unpaid one should expire
        assert len(expired) == 1
        assert expired[0][0] == "u_unpaid"

    def test_keeps_entries_before_deadline(self):
        wl = Waitlist()
        wl.add_pending_payment("u1", TIER, ["s1"], price=50.0, deadline_minutes=60)
        # Only 10 minutes in -- still within deadline
        now = datetime.now(timezone.utc) + timedelta(minutes=10)
        expired = wl.expire_unpaid(now=now)
        assert expired == []

    def test_expire_removes_from_pending_list(self):
        wl = Waitlist()
        wl.add_pending_payment("u1", TIER, ["s1"], price=50.0, deadline_minutes=30)
        now = datetime.now(timezone.utc) + timedelta(minutes=60)
        wl.expire_unpaid(now=now)

        # Calling again should yield nothing (already removed)
        second = wl.expire_unpaid(now=now + timedelta(minutes=1))
        assert second == []


# ===========================================================================
# Empty waitlist handling
# ===========================================================================

class TestEmptyWaitlist:
    """Verify graceful behavior on an empty waitlist."""

    def test_get_entries_empty(self):
        wl = Waitlist()
        assert wl.get_entries(TIER) == []

    def test_get_position_empty(self):
        wl = Waitlist()
        assert wl.get_position("u1", TIER) is None

    def test_remove_from_empty(self):
        wl = Waitlist()
        assert wl.remove("u1", TIER) is False

    def test_size_empty(self):
        wl = Waitlist()
        assert wl.size(TIER) == 0


# ===========================================================================
# Multiple tiers are independent
# ===========================================================================

class TestMultipleTiers:
    """Tiers maintain separate waitlists."""

    def test_tiers_independent(self):
        wl = Waitlist()
        wl.add(_entry("u1", tier_id=TIER, priority=80.0))
        wl.add(_entry("u2", tier_id=TIER_B, priority=90.0))

        assert wl.size(TIER) == 1
        assert wl.size(TIER_B) == 1
        assert wl.get_position("u1", TIER) == 1
        assert wl.get_position("u2", TIER_B) == 1
        # u2 should NOT appear in TIER
        assert wl.get_position("u2", TIER) is None

    def test_cancellation_only_affects_tier(self):
        wl = Waitlist()
        wl.add(_entry("u_a", tier_id=TIER, priority=50.0))
        wl.add(_entry("u_b", tier_id=TIER_B, priority=50.0))

        results = wl.process_cancellation(TIER, freed_seats=1)
        assert len(results) == 1
        assert results[0].user_id == "u_a"
        # TIER_B unaffected
        assert wl.size(TIER_B) == 1
