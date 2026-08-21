"""
Dutch Auction Engine Tests
===========================
Validates creation, price curves, purchasing, schedule generation,
and activity states for the descending-price Dutch auction.
"""

import pytest
from datetime import datetime, timedelta, timezone

from talkfile_engine.dutch_auction import (
    DutchAuctionState,
    DutchPurchase,
    create_dutch_auction,
    get_current_price,
    get_current_step,
    attempt_purchase,
    get_price_schedule,
    is_active,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _utc_now() -> datetime:
    return datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)


def _default_auction(start_at: datetime | None = None, **overrides) -> DutchAuctionState:
    """Create a standard test auction: $100 start, $20 floor, $10/step, 5-min intervals, 50 seats."""
    kwargs = dict(
        tier_id="tier-A",
        start_price=100.0,
        floor_price=20.0,
        step_amount=10.0,
        step_interval_minutes=5,
        total_seats=50,
        start_at=start_at,
    )
    kwargs.update(overrides)
    return create_dutch_auction(**kwargs)


# ===========================================================================
# Creation / validation
# ===========================================================================

class TestCreateDutchAuction:
    """Test create_dutch_auction() validation."""

    def test_valid_creation(self):
        state = _default_auction(start_at=_utc_now())
        assert state.tier_id == "tier-A"
        assert state.start_price == 100.0
        assert state.remaining_seats == 50

    def test_negative_start_price_rejected(self):
        with pytest.raises(ValueError, match="start_price must be positive"):
            create_dutch_auction(
                tier_id="t", start_price=-10, floor_price=0,
                step_amount=5, step_interval_minutes=5, total_seats=10,
            )

    def test_zero_start_price_rejected(self):
        with pytest.raises(ValueError, match="start_price must be positive"):
            create_dutch_auction(
                tier_id="t", start_price=0, floor_price=0,
                step_amount=5, step_interval_minutes=5, total_seats=10,
            )

    def test_negative_floor_price_rejected(self):
        with pytest.raises(ValueError, match="floor_price must be non-negative"):
            create_dutch_auction(
                tier_id="t", start_price=100, floor_price=-5,
                step_amount=10, step_interval_minutes=5, total_seats=10,
            )

    def test_floor_greater_than_start_rejected(self):
        with pytest.raises(ValueError, match="floor_price must be <= start_price"):
            create_dutch_auction(
                tier_id="t", start_price=50, floor_price=100,
                step_amount=10, step_interval_minutes=5, total_seats=10,
            )

    def test_negative_step_amount_rejected(self):
        with pytest.raises(ValueError, match="step_amount must be positive"):
            create_dutch_auction(
                tier_id="t", start_price=100, floor_price=20,
                step_amount=-1, step_interval_minutes=5, total_seats=10,
            )

    def test_zero_step_interval_rejected(self):
        with pytest.raises(ValueError, match="step_interval_minutes must be positive"):
            create_dutch_auction(
                tier_id="t", start_price=100, floor_price=20,
                step_amount=10, step_interval_minutes=0, total_seats=10,
            )

    def test_negative_remaining_seats_rejected(self):
        with pytest.raises(ValueError, match="remaining_seats must be non-negative"):
            create_dutch_auction(
                tier_id="t", start_price=100, floor_price=20,
                step_amount=10, step_interval_minutes=5, total_seats=-1,
            )


# ===========================================================================
# Price curve
# ===========================================================================

class TestGetCurrentPrice:
    """Test get_current_price() at various times."""

    def test_price_at_start(self):
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        assert get_current_price(state, t0) == 100.0

    def test_price_after_one_step(self):
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        assert get_current_price(state, t0 + timedelta(minutes=5)) == 90.0

    def test_price_middle_of_step(self):
        """Within a step interval the price should not change."""
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        assert get_current_price(state, t0 + timedelta(minutes=7)) == 90.0

    def test_price_reaches_floor(self):
        """After enough steps the price must clamp at the floor."""
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        # 8 steps of $10 drop = $80 off -> price = $20 = floor
        assert get_current_price(state, t0 + timedelta(minutes=40)) == 20.0

    def test_price_stays_at_floor(self):
        """Price should not drop below the floor even much later."""
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        assert get_current_price(state, t0 + timedelta(hours=24)) == 20.0

    def test_price_before_start(self):
        """Querying before the auction started returns start_price."""
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        assert get_current_price(state, t0 - timedelta(minutes=10)) == 100.0

    def test_price_when_not_started(self):
        """Auction with no started_at returns start_price."""
        state = _default_auction(start_at=None)
        assert get_current_price(state, _utc_now()) == 100.0


# ===========================================================================
# Purchasing
# ===========================================================================

class TestAttemptPurchase:
    """Test attempt_purchase() success and failure paths."""

    def test_successful_purchase(self):
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        now = t0 + timedelta(minutes=5)
        result = attempt_purchase(state, "user1", 2, now)

        assert result is not None
        assert result.user_id == "user1"
        assert result.quantity == 2
        assert result.price == 90.0  # 1 step down
        assert result.purchased_at == now

    def test_purchase_reduces_remaining_seats(self):
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        attempt_purchase(state, "u1", 3, t0)
        assert state.remaining_seats == 47

    def test_multiple_purchases_reduce_seats_cumulatively(self):
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        attempt_purchase(state, "u1", 10, t0)
        attempt_purchase(state, "u2", 15, t0)
        assert state.remaining_seats == 25
        assert len(state.purchases) == 2

    def test_purchase_fails_not_enough_seats(self):
        t0 = _utc_now()
        state = _default_auction(start_at=t0, total_seats=5)
        result = attempt_purchase(state, "u1", 10, t0)
        assert result is None
        assert state.remaining_seats == 5  # unchanged

    def test_purchase_fails_when_not_started(self):
        state = _default_auction(start_at=None)
        result = attempt_purchase(state, "u1", 1, _utc_now())
        assert result is None

    def test_purchase_zero_quantity(self):
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        result = attempt_purchase(state, "u1", 0, t0)
        assert result is None


# ===========================================================================
# Price schedule
# ===========================================================================

class TestGetPriceSchedule:
    """Test get_price_schedule() output."""

    def test_schedule_not_started(self):
        state = _default_auction(start_at=None)
        assert get_price_schedule(state) == []

    def test_schedule_entries(self):
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        schedule = get_price_schedule(state)

        # $100 -> $90 -> $80 -> $70 -> $60 -> $50 -> $40 -> $30 -> $20 (floor)
        # That is 9 entries (steps 0-8)
        assert len(schedule) == 9
        assert schedule[0] == (t0, 100.0)
        assert schedule[-1][1] == 20.0  # floor price

    def test_schedule_times_are_correct(self):
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        schedule = get_price_schedule(state)
        for i, (t, _) in enumerate(schedule):
            assert t == t0 + timedelta(minutes=5 * i)


# ===========================================================================
# Active state
# ===========================================================================

class TestIsActive:
    """Test is_active() at various states."""

    def test_active_after_start(self):
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        assert is_active(state, t0 + timedelta(minutes=1)) is True

    def test_not_active_before_start(self):
        t0 = _utc_now()
        state = _default_auction(start_at=t0)
        assert is_active(state, t0 - timedelta(minutes=1)) is False

    def test_not_active_when_not_started(self):
        state = _default_auction(start_at=None)
        assert is_active(state, _utc_now()) is False

    def test_not_active_when_sold_out(self):
        t0 = _utc_now()
        state = _default_auction(start_at=t0, total_seats=2)
        attempt_purchase(state, "u1", 2, t0)
        assert is_active(state, t0) is False
