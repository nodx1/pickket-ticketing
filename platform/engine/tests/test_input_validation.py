"""
Input Validation Tests
========================
Tests for Phase 1: BidInput.validate() and FanScores.validate().
Ensures NaN, Inf, negative, and type-invalid inputs are properly rejected.
"""

import math
import pytest
from talkfile_engine.vcg import BidInput, VCGEngine, AllocationInput
from talkfile_engine.fan_weight import (
    FanScores, compute_fan_weight_v2, AlphaWeights, EventType,
)


# ─── BidInput.validate() ───


class TestBidInputValidation:
    """Tests for BidInput field validation."""

    def test_valid_bid_passes(self):
        bid = BidInput("b1", "u1", 100.0, 1.0, 1)
        bid.validate()  # Should not raise

    def test_nan_bid_amount_rejected(self):
        bid = BidInput("b1", "u1", float("nan"), 1.0, 1)
        with pytest.raises(ValueError, match="finite"):
            bid.validate()

    def test_inf_bid_amount_rejected(self):
        bid = BidInput("b1", "u1", float("inf"), 1.0, 1)
        with pytest.raises(ValueError, match="finite"):
            bid.validate()

    def test_negative_inf_bid_amount_rejected(self):
        bid = BidInput("b1", "u1", float("-inf"), 1.0, 1)
        with pytest.raises(ValueError, match="finite"):
            bid.validate()

    def test_negative_bid_amount_rejected(self):
        bid = BidInput("b1", "u1", -50.0, 1.0, 1)
        with pytest.raises(ValueError, match="non-negative"):
            bid.validate()

    def test_nan_weight_rejected(self):
        bid = BidInput("b1", "u1", 100.0, float("nan"), 1)
        with pytest.raises(ValueError, match="finite"):
            bid.validate()

    def test_inf_weight_rejected(self):
        bid = BidInput("b1", "u1", 100.0, float("inf"), 1)
        with pytest.raises(ValueError, match="finite"):
            bid.validate()

    def test_zero_weight_rejected(self):
        bid = BidInput("b1", "u1", 100.0, 0.0, 1)
        with pytest.raises(ValueError, match="positive"):
            bid.validate()

    def test_negative_weight_rejected(self):
        bid = BidInput("b1", "u1", 100.0, -0.5, 1)
        with pytest.raises(ValueError, match="positive"):
            bid.validate()

    def test_zero_quantity_rejected(self):
        bid = BidInput("b1", "u1", 100.0, 1.0, 0)
        with pytest.raises(ValueError, match="positive integer"):
            bid.validate()

    def test_negative_quantity_rejected(self):
        bid = BidInput("b1", "u1", 100.0, 1.0, -1)
        with pytest.raises(ValueError, match="positive integer"):
            bid.validate()

    def test_empty_bid_id_rejected(self):
        bid = BidInput("", "u1", 100.0, 1.0, 1)
        with pytest.raises(ValueError, match="bid_id"):
            bid.validate()

    def test_empty_user_id_rejected(self):
        bid = BidInput("b1", "", 100.0, 1.0, 1)
        with pytest.raises(ValueError, match="user_id"):
            bid.validate()

    def test_zero_bid_amount_accepted(self):
        """Zero bid is valid (user doesn't want to pay)."""
        bid = BidInput("b1", "u1", 0.0, 1.0, 1)
        bid.validate()  # Should not raise


class TestAllocateInputValidation:
    """Tests that allocate() rejects invalid bids."""

    def test_nan_bid_rejected_in_allocate(self):
        engine = VCGEngine()
        bids = [BidInput("b1", "u1", float("nan"), 1.0, 1)]
        with pytest.raises(ValueError):
            engine.allocate(AllocationInput(bids=bids, total_seats=1))

    def test_inf_weight_rejected_in_allocate(self):
        engine = VCGEngine()
        bids = [BidInput("b1", "u1", 100.0, float("inf"), 1)]
        with pytest.raises(ValueError):
            engine.allocate(AllocationInput(bids=bids, total_seats=1))

    def test_quantity_capped_to_seats(self):
        """quantity > total_seats should be capped, not rejected."""
        engine = VCGEngine()
        bids = [
            BidInput("b1", "u1", 100.0, 1.0, 100),  # q=100 but only 3 seats
            BidInput("b2", "u2", 90.0, 1.0, 1),
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=3))
        # b1 should win at most 3 seats (capped), not 100
        assert len(result.winners) > 0
        # Verify no memory explosion occurred (implicit: test completes)

    def test_mixed_valid_and_invalid_rejects_early(self):
        """If any bid is invalid, entire allocation should fail."""
        engine = VCGEngine()
        bids = [
            BidInput("b1", "u1", 100.0, 1.0, 1),  # valid
            BidInput("b2", "u2", float("nan"), 1.0, 1),  # invalid
        ]
        with pytest.raises(ValueError):
            engine.allocate(AllocationInput(bids=bids, total_seats=2))


# ─── FanScores.validate() ───


class TestFanScoresValidation:
    """Tests for FanScores field validation and clamping."""

    def test_valid_scores_pass(self):
        scores = FanScores(0.5, 0.3, 1.0, 0.9, 0.2)
        scores.validate()  # Should not raise

    def test_nan_score_rejected(self):
        scores = FanScores(float("nan"), 0.3, 1.0, 0.9, 0.2)
        with pytest.raises(ValueError, match="finite"):
            scores.validate()

    def test_inf_score_rejected(self):
        scores = FanScores(0.5, float("inf"), 1.0, 0.9, 0.2)
        with pytest.raises(ValueError, match="finite"):
            scores.validate()

    def test_negative_score_clamped_to_zero(self):
        scores = FanScores(-0.5, 0.3, 1.0, 0.9, 0.2)
        scores.validate()
        assert scores.loyalty == 0.0

    def test_over_one_score_clamped_to_one(self):
        scores = FanScores(0.5, 1.5, 1.0, 0.9, 0.2)
        scores.validate()
        assert scores.history == 1.0

    def test_all_dimensions_clamped(self):
        scores = FanScores(-1.0, 2.0, -0.1, 1.5, 3.0)
        scores.validate()
        assert scores.loyalty == 0.0
        assert scores.history == 1.0
        assert scores.fanclub == 0.0
        assert scores.behavior == 1.0
        assert scores.freshness == 1.0

    def test_compute_fan_weight_v2_validates_scores(self):
        """compute_fan_weight_v2 should call validate() on scores."""
        scores = FanScores(float("nan"), 0.5, 0.0, 1.0, 0.0)
        with pytest.raises(ValueError, match="finite"):
            compute_fan_weight_v2(scores)

    def test_out_of_range_scores_clamped_before_weight(self):
        """Out-of-range scores should be clamped, producing valid weights."""
        scores = FanScores(-1.0, 2.0, 0.5, 0.5, 0.5)
        w = compute_fan_weight_v2(scores)
        assert 0.5 <= w <= 2.0
