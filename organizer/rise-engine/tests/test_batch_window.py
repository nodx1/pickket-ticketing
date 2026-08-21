"""
Batch Window Tests
====================
Comprehensive tests for batch_window.py: state machine, bid acceptance,
randomized close, competition signals, bid amendment policy.
"""

import math
import pytest
from datetime import datetime, timedelta, timezone

from talkfile_engine.batch_window import (
    AuctionPhase,
    BatchWindow,
    BatchWindowConfig,
    BidAmendmentPolicy,
    VALID_TRANSITIONS,
    MIN_WINDOW_HOURS,
    MAX_WINDOW_HOURS,
    MAX_RANDOM_DELAY_MINUTES,
    create_window,
    transition_phase,
    can_accept_bid,
    should_close,
    should_start_closing,
    get_competition_band,
    get_competition_signal,
    get_public_info,
    can_amend_bid,
)


NOW = datetime(2026, 3, 1, 12, 0, 0, tzinfo=timezone.utc)


# ─── Window Creation ───


class TestBatchWindowCreation:

    def test_create_default_config(self):
        w = create_window("evt1", NOW)
        assert w.event_id == "evt1"
        assert w.phase == AuctionPhase.DRAFT
        assert w.opens_at == NOW
        assert w.scheduled_close_at == NOW + timedelta(hours=48)

    def test_create_custom_hours(self):
        config = BatchWindowConfig(window_hours=24)
        w = create_window("evt1", NOW, config)
        assert w.scheduled_close_at == NOW + timedelta(hours=24)

    def test_create_max_hours(self):
        config = BatchWindowConfig(window_hours=72)
        w = create_window("evt1", NOW, config)
        assert w.scheduled_close_at == NOW + timedelta(hours=72)

    def test_invalid_hours_too_low(self):
        config = BatchWindowConfig(window_hours=12)
        with pytest.raises(ValueError, match="Window hours"):
            create_window("evt1", NOW, config)

    def test_invalid_hours_too_high(self):
        config = BatchWindowConfig(window_hours=100)
        with pytest.raises(ValueError, match="Window hours"):
            create_window("evt1", NOW, config)

    def test_negative_min_price(self):
        config = BatchWindowConfig(min_price=-10)
        with pytest.raises(ValueError, match="min_price"):
            create_window("evt1", NOW, config)

    def test_max_less_than_min(self):
        config = BatchWindowConfig(min_price=100, max_price=50)
        with pytest.raises(ValueError, match="max_price"):
            create_window("evt1", NOW, config)

    def test_valid_price_range(self):
        config = BatchWindowConfig(min_price=50, max_price=200)
        w = create_window("evt1", NOW, config)
        assert w.config.min_price == 50
        assert w.config.max_price == 200


# ─── State Machine Transitions ───


class TestStateMachineTransitions:

    def test_happy_path_full_lifecycle(self):
        """DRAFT → OPEN → CLOSING → CLOSED → ALLOCATING → ALLOCATED → COMPLETED"""
        w = create_window("evt1", NOW)
        phases = [
            AuctionPhase.BIDDING_OPEN,
            AuctionPhase.BIDDING_CLOSING,
            AuctionPhase.BIDDING_CLOSED,
            AuctionPhase.ALLOCATING,
            AuctionPhase.ALLOCATED,
            AuctionPhase.COMPLETED,
        ]
        for phase in phases:
            w = transition_phase(w, phase)
            assert w.phase == phase

    def test_invalid_draft_to_closed(self):
        w = create_window("evt1", NOW)
        with pytest.raises(ValueError, match="Invalid transition"):
            transition_phase(w, AuctionPhase.BIDDING_CLOSED)

    def test_cannot_skip_closing(self):
        w = create_window("evt1", NOW)
        w = transition_phase(w, AuctionPhase.BIDDING_OPEN)
        with pytest.raises(ValueError, match="Invalid transition"):
            transition_phase(w, AuctionPhase.BIDDING_CLOSED)

    def test_cannot_go_backwards(self):
        w = create_window("evt1", NOW)
        w = transition_phase(w, AuctionPhase.BIDDING_OPEN)
        with pytest.raises(ValueError):
            transition_phase(w, AuctionPhase.DRAFT)

    def test_completed_is_terminal(self):
        w = create_window("evt1", NOW)
        for phase in [AuctionPhase.BIDDING_OPEN, AuctionPhase.BIDDING_CLOSING,
                      AuctionPhase.BIDDING_CLOSED, AuctionPhase.ALLOCATING,
                      AuctionPhase.ALLOCATED, AuctionPhase.COMPLETED]:
            w = transition_phase(w, phase)
        with pytest.raises(ValueError):
            transition_phase(w, AuctionPhase.DRAFT)

    def test_closing_generates_random_delay(self):
        w = create_window("evt1", NOW)
        w = transition_phase(w, AuctionPhase.BIDDING_OPEN)
        w = transition_phase(w, AuctionPhase.BIDDING_CLOSING)
        assert 0 <= w.random_delay_minutes <= MAX_RANDOM_DELAY_MINUTES
        assert w.actual_close_at is not None
        assert w.actual_close_at >= w.scheduled_close_at


# ─── Bid Acceptance ───


class TestBidAcceptance:

    def test_accept_during_open(self):
        w = create_window("evt1", NOW)
        w = transition_phase(w, AuctionPhase.BIDDING_OPEN)
        assert can_accept_bid(w, NOW + timedelta(hours=1))

    def test_accept_during_closing_before_actual_close(self):
        w = create_window("evt1", NOW)
        w = transition_phase(w, AuctionPhase.BIDDING_OPEN)
        w = transition_phase(w, AuctionPhase.BIDDING_CLOSING)
        # Before actual close, still accepting
        assert can_accept_bid(w, w.scheduled_close_at)

    def test_reject_during_closing_after_actual_close(self):
        w = create_window("evt1", NOW)
        w = transition_phase(w, AuctionPhase.BIDDING_OPEN)
        w = transition_phase(w, AuctionPhase.BIDDING_CLOSING)
        # After actual close
        after = w.actual_close_at + timedelta(minutes=1)
        assert not can_accept_bid(w, after)

    def test_reject_during_draft(self):
        w = create_window("evt1", NOW)
        assert not can_accept_bid(w, NOW)

    def test_reject_during_closed(self):
        w = create_window("evt1", NOW)
        w = transition_phase(w, AuctionPhase.BIDDING_OPEN)
        w = transition_phase(w, AuctionPhase.BIDDING_CLOSING)
        w = transition_phase(w, AuctionPhase.BIDDING_CLOSED)
        assert not can_accept_bid(w, NOW + timedelta(hours=50))

    def test_reject_during_allocating(self):
        w = create_window("evt1", NOW)
        for p in [AuctionPhase.BIDDING_OPEN, AuctionPhase.BIDDING_CLOSING,
                  AuctionPhase.BIDDING_CLOSED, AuctionPhase.ALLOCATING]:
            w = transition_phase(w, p)
        assert not can_accept_bid(w, NOW + timedelta(hours=50))


# ─── Should Close / Start Closing ───


class TestClosingLogic:

    def test_should_start_closing_at_scheduled_time(self):
        w = create_window("evt1", NOW)
        w = transition_phase(w, AuctionPhase.BIDDING_OPEN)
        assert not should_start_closing(w, NOW + timedelta(hours=1))
        assert should_start_closing(w, w.scheduled_close_at)
        assert should_start_closing(w, w.scheduled_close_at + timedelta(minutes=1))

    def test_should_not_start_closing_if_not_open(self):
        w = create_window("evt1", NOW)
        assert not should_start_closing(w, w.scheduled_close_at + timedelta(hours=1))

    def test_should_close_after_actual_close(self):
        w = create_window("evt1", NOW)
        w = transition_phase(w, AuctionPhase.BIDDING_OPEN)
        w = transition_phase(w, AuctionPhase.BIDDING_CLOSING)
        assert not should_close(w, w.scheduled_close_at)  # Before actual close
        assert should_close(w, w.actual_close_at + timedelta(seconds=1))

    def test_should_close_not_in_closing_phase(self):
        w = create_window("evt1", NOW)
        w = transition_phase(w, AuctionPhase.BIDDING_OPEN)
        assert not should_close(w, NOW + timedelta(hours=100))


# ─── Competition Bands (legacy) ───


class TestCompetitionBands:

    def test_low_band(self):
        assert get_competition_band(50, 100) == "low"

    def test_moderate_band(self):
        assert get_competition_band(150, 100) == "moderate"

    def test_high_band(self):
        assert get_competition_band(300, 100) == "high"

    def test_very_high_band(self):
        assert get_competition_band(600, 100) == "very_high"

    def test_zero_seats_unknown(self):
        assert get_competition_band(100, 0) == "unknown"

    def test_exact_boundary_moderate(self):
        """ratio=1.0 should be moderate (>= 1.0)."""
        assert get_competition_band(100, 100) == "moderate"


# ─── Competition Signal (continuous, Phase 5) ───


class TestCompetitionSignal:

    def test_zero_seats(self):
        sig = get_competition_signal(100, 0)
        assert sig["intensity"] == 0.0

    def test_low_ratio_low_intensity(self):
        sig = get_competition_signal(50, 100)  # ratio=0.5
        assert sig["intensity"] < 0.2

    def test_moderate_ratio(self):
        sig = get_competition_signal(150, 100)  # ratio=1.5
        # At center of sigmoid, intensity ≈ 0.5
        assert 0.4 <= sig["intensity"] <= 0.6

    def test_high_ratio_high_intensity(self):
        sig = get_competition_signal(500, 100)  # ratio=5.0
        assert sig["intensity"] > 0.95

    def test_intensity_monotonic(self):
        """Higher ratio → higher intensity."""
        prev = 0.0
        for ratio_x10 in range(1, 50):
            bid_count = ratio_x10 * 10
            sig = get_competition_signal(bid_count, 100)
            assert sig["intensity"] >= prev - 1e-9
            prev = sig["intensity"]

    def test_description_is_string(self):
        sig = get_competition_signal(200, 100)
        assert isinstance(sig["description"], str)
        assert len(sig["description"]) > 0


# ─── Public Info Disclosure ───


class TestPublicInfoDisclosure:

    def test_never_exposes_bid_count(self):
        w = create_window("evt1", NOW)
        w.bid_count = 2847
        info = get_public_info(w, 1000)
        # Should not contain exact bid count
        assert "2847" not in str(info)
        assert "bid_count" not in info

    def test_exposes_competition_band(self):
        w = create_window("evt1", NOW)
        w.bid_count = 300
        info = get_public_info(w, 100)
        assert "competition_band" in info

    def test_exposes_price_range(self):
        config = BatchWindowConfig(min_price=50000, max_price=200000)
        w = create_window("evt1", NOW, config)
        info = get_public_info(w, 100)
        assert info["price_range"]["min"] == 50000
        assert info["price_range"]["max"] == 200000


# ─── Bid Amendment Policy (Phase 5) ───


class TestBidAmendmentPolicy:

    def _open_window(self):
        w = create_window("evt1", NOW)
        w = transition_phase(w, AuctionPhase.BIDDING_OPEN)
        return w

    def test_first_amendment_allowed(self):
        w = self._open_window()
        allowed, reason = can_amend_bid(w, 0, now=NOW + timedelta(hours=1))
        assert allowed

    def test_max_amendments_reached(self):
        w = self._open_window()
        allowed, reason = can_amend_bid(w, 3, now=NOW + timedelta(hours=1))
        assert not allowed
        assert "Maximum" in reason

    def test_cooldown_enforced(self):
        w = self._open_window()
        last = NOW + timedelta(hours=1)
        too_soon = last + timedelta(minutes=10)  # Only 10 min, need 30
        allowed, reason = can_amend_bid(w, 1, last_amendment_at=last, now=too_soon)
        assert not allowed
        assert "wait" in reason.lower()

    def test_cooldown_passed(self):
        w = self._open_window()
        last = NOW + timedelta(hours=1)
        enough = last + timedelta(minutes=31)
        allowed, _ = can_amend_bid(w, 1, last_amendment_at=last, now=enough)
        assert allowed

    def test_lock_before_close(self):
        w = self._open_window()
        # 30 minutes before close (within 60-minute lock)
        near_close = w.scheduled_close_at - timedelta(minutes=30)
        allowed, reason = can_amend_bid(w, 0, now=near_close)
        assert not allowed
        assert "locked" in reason.lower()

    def test_custom_policy(self):
        w = self._open_window()
        policy = BidAmendmentPolicy(max_amendments=5, cooldown_minutes=10, lock_before_close_minutes=30)
        allowed, _ = can_amend_bid(w, 4, now=NOW + timedelta(hours=1), policy=policy)
        assert allowed

    def test_not_accepting_bids(self):
        w = create_window("evt1", NOW)  # DRAFT phase
        allowed, reason = can_amend_bid(w, 0, now=NOW)
        assert not allowed
        assert "not accepting" in reason.lower()
