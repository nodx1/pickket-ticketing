"""
End-to-End Integration Tests
===============================
Tests the complete allocation pipeline:
  Layer 1: Eligibility gate (eligibility.py)
  Layer 2: Fan weight computation (fan_weight.py)
  Layer 3: Multi-pool routing + VCG allocation (vcg.py)

These tests simulate realistic scenarios exercising module boundaries.
"""

import random as rng
import pytest
from talkfile_engine.vcg import VCGEngine, AllocationInput, BidInput
from talkfile_engine.fan_weight import (
    FanScores, AlphaWeights, EventType, compute_fan_weight_v2,
    compute_history_score, compute_freshness_score, compute_behavior_score,
    compute_loyalty_score,
)
from talkfile_engine.eligibility import (
    UserEligibility, VerificationLevel, Pool, EligibilityResult,
    check_eligibility, compute_pool_seats, compute_abuse_score,
)


class TestFullPipeline:
    """Complete pipeline: eligibility → weight → VCG allocation."""

    def test_10_users_diverse_profiles(self):
        """10 users with varying profiles, allocated across pools."""
        users = [
            UserEligibility("u1", VerificationLevel.REAL_NAME, False, True, 0.0),   # Pool A, D
            UserEligibility("u2", VerificationLevel.PHONE, True, False, 0.0),       # Pool A, B
            UserEligibility("u3", VerificationLevel.UNVERIFIED, False, False, 0.0), # Pool C only
            UserEligibility("u4", VerificationLevel.REAL_NAME, True, True, 0.0),    # Pool A, B, D
            UserEligibility("u5", VerificationLevel.PHONE, False, False, 0.0),      # Pool A
            UserEligibility("u6", VerificationLevel.FOREIGN_ALT, False, True, 0.0), # Pool A, D
            UserEligibility("u7", VerificationLevel.UNVERIFIED, True, False, 0.0),  # Pool C (new but unverified)
            UserEligibility("u8", VerificationLevel.PHONE, False, False, 0.1),      # Pool A (low abuse)
            UserEligibility("u9", VerificationLevel.REAL_NAME, False, False, 0.8),  # BLOCKED
            UserEligibility("u10", VerificationLevel.PHONE, True, False, 0.0),      # Pool A, B
        ]

        # Check eligibility
        results = [check_eligibility(u) for u in users]

        # u9 should be blocked
        assert results[8].is_blocked
        assert len(results[8].eligible_pools) == 0

        # u3, u7 should only be in Pool C
        assert results[2].eligible_pools == [Pool.C]
        assert results[6].eligible_pools == [Pool.C]

        # u1 should be in A, D, C
        assert Pool.A in results[0].eligible_pools
        assert Pool.D in results[0].eligible_pools
        assert Pool.C in results[0].eligible_pools

        # u4 should be in A, B, D, C (all pools)
        assert Pool.A in results[3].eligible_pools
        assert Pool.B in results[3].eligible_pools
        assert Pool.D in results[3].eligible_pools
        assert Pool.C in results[3].eligible_pools

    def test_weight_computation_and_vcg_pricing(self):
        """Compute weights, then run VCG, verify IR and pricing."""
        # Create fan profiles with different characteristics
        profiles = [
            FanScores(loyalty=0.9, history=0.8, fanclub=1.0, behavior=0.95, freshness=0.0),  # Veteran fan
            FanScores(loyalty=0.0, history=0.0, fanclub=0.0, behavior=1.0, freshness=1.0),    # New user
            FanScores(loyalty=0.5, history=0.3, fanclub=1.0, behavior=0.8, freshness=0.0),    # Moderate fan
            FanScores(loyalty=0.1, history=0.1, fanclub=0.0, behavior=0.7, freshness=0.5),    # Casual
        ]

        weights = [compute_fan_weight_v2(s) for s in profiles]

        # Veteran should have highest weight
        assert weights[0] > weights[1]
        assert weights[0] > weights[2]
        assert weights[0] > weights[3]

        # All weights in valid range
        for w in weights:
            assert 0.5 <= w <= 2.0

        # Run VCG with these weights
        bids = [
            BidInput("b1", "u1", 100000, weights[0], 1),
            BidInput("b2", "u2", 120000, weights[1], 1),
            BidInput("b3", "u3", 90000, weights[2], 1),
            BidInput("b4", "u4", 80000, weights[3], 1),
        ]

        engine = VCGEngine()
        result = engine.allocate(AllocationInput(bids=bids, total_seats=2))

        assert len(result.winners) == 2
        # IR: every winner pays ≤ their bid
        for w in result.winners:
            assert w.final_price <= w.bid_amount + 1e-6

    def test_pool_seat_allocation_totals(self):
        """Pool seat allocation totals always match."""
        for total in [1, 10, 100, 999, 1000, 5000, 10001]:
            seats = compute_pool_seats(total)
            assert sum(seats.values()) == total

    def test_pool_seat_remainder_goes_to_a(self):
        """Verify Pool A gets the remainder after rounding."""
        seats = compute_pool_seats(1000)
        # A=650, B=150, C=100, D=100
        assert seats[Pool.A] == 650
        assert seats[Pool.B] == 150
        assert seats[Pool.C] == 100
        assert seats[Pool.D] == 100


class TestWeightToVCGInteraction:
    """Verify fan weight correctly flows into VCG pricing."""

    def test_higher_weight_lower_payment(self):
        """Higher weight → lower VCG payment (same bid amount)."""
        engine = VCGEngine()
        bids = [
            BidInput("b1", "u1", 100000, 1.5, 1),  # High weight
            BidInput("b2", "u2", 100000, 1.0, 1),  # Low weight
            BidInput("b3", "u3", 80000, 1.0, 1),   # Loser
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=2))

        winners = {w.user_id: w for w in result.winners}
        assert "u1" in winners and "u2" in winners
        # u1 (w=1.5) should pay less than u2 (w=1.0)
        assert winners["u1"].final_price < winners["u2"].final_price

    def test_weight_affects_allocation_order(self):
        """Lower bid can win over higher bid if weight is higher."""
        engine = VCGEngine()
        bids = [
            BidInput("b1", "u1", 80000, 2.0, 1),   # wv=160000 (wins)
            BidInput("b2", "u2", 100000, 1.0, 1),   # wv=100000 (wins)
            BidInput("b3", "u3", 95000, 1.0, 1),    # wv=95000 (loses)
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=2))

        winner_ids = {w.user_id for w in result.winners}
        assert "u1" in winner_ids  # Lower bid but higher weight → wins
        assert "u3" not in winner_ids


class TestPoolOverflow:
    """Test behavior when pool has 0 eligible users."""

    def test_all_unverified_only_pool_c(self):
        """If all users are unverified, only Pool C is populated."""
        users = [
            UserEligibility(f"u{i}", VerificationLevel.UNVERIFIED)
            for i in range(10)
        ]
        for u in users:
            result = check_eligibility(u)
            assert result.eligible_pools == [Pool.C]

    def test_no_fanclub_members_pool_d_empty(self):
        """If no fanclub members, Pool D would have 0 eligible users."""
        users = [
            UserEligibility(f"u{i}", VerificationLevel.REAL_NAME, is_fanclub_member=False)
            for i in range(10)
        ]
        for u in users:
            result = check_eligibility(u)
            assert Pool.D not in result.eligible_pools


class TestRealisticScenario:
    """Realistic concert ticket allocation scenarios."""

    def test_high_demand_concert_1000_seats(self):
        """K-pop concert: 5000 bids for 1000 seats with diverse weights."""
        rng.seed(42)
        engine = VCGEngine()

        bids = []
        for i in range(5000):
            weight = rng.uniform(0.6, 1.9)
            bid_amount = rng.uniform(50000, 300000)
            bids.append(BidInput(f"b{i}", f"u{i}", bid_amount, weight, 1))

        result = engine.allocate(AllocationInput(bids=bids, total_seats=1000))

        assert len(result.winners) == 1000
        assert result.total_bids == 5000
        assert result.competition_ratio == 5.0
        assert result.total_revenue > 0

        # All winners satisfy IR
        for w in result.winners:
            assert w.final_price <= w.bid_amount + 1e-6

        # Behavioral metrics should be computed
        assert result.total_consumer_surplus >= 0
        assert result.gini_coefficient >= 0

    def test_low_demand_everyone_wins(self):
        """Small venue, under-subscribed: everyone wins, price = 0."""
        engine = VCGEngine()
        bids = [
            BidInput(f"b{i}", f"u{i}", rng.uniform(30000, 100000), 1.0, 1)
            for i in range(50)
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=100))

        assert len(result.winners) == 50
        # When everyone wins, VCG prices should be 0 (no externality)
        for w in result.winners:
            assert w.vcg_price == 0.0

    def test_behavioral_metrics_computed(self):
        """Verify all behavioral metrics are populated."""
        engine = VCGEngine()
        rng.seed(123)
        bids = [
            BidInput(f"b{i}", f"u{i}", rng.uniform(50000, 200000), rng.uniform(0.6, 1.8), 1)
            for i in range(100)
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=20))

        # Consumer surplus
        assert result.total_consumer_surplus > 0
        assert 0 <= result.avg_surplus_ratio <= 1.0
        assert result.overbidding_indicator > 0

        # Fairness
        assert result.price_ratio_max >= 1.0
        assert 0 <= result.gini_coefficient <= 1.0

        # Weight-price correlation (should be negative: higher weight → lower price)
        assert result.weight_price_correlation < 0

    def test_resale_risk_scores_populated(self):
        """Verify resale_risk_score is computed for all winners."""
        engine = VCGEngine()
        bids = [
            BidInput("b1", "u1", 150000, 1.8, 1),
            BidInput("b2", "u2", 120000, 0.7, 1),
            BidInput("b3", "u3", 80000, 1.0, 1),
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=2))

        for w in result.winners:
            assert w.resale_risk_score >= 0.0
            assert w.resale_risk_score <= 1.0

    def test_helper_score_functions(self):
        """Integration test for all score computation helpers."""
        # History with decay
        h = compute_history_score([(0, 5), (365, 3), (730, 2)])
        assert 0 < h <= 1.0

        # Freshness
        assert compute_freshness_score(0) == 1.0
        assert compute_freshness_score(90) == pytest.approx(0.5, abs=0.01)
        assert compute_freshness_score(200) == 0.0

        # Behavior
        assert compute_behavior_score(0.0, 0.0, 0.0) == 1.0
        assert compute_behavior_score(1.0, 1.0, 1.0) == 0.0

        # Loyalty
        assert compute_loyalty_score() == 0.5  # No data → neutral
        assert compute_loyalty_score(60, 500, 36) == 1.0  # Max everything
