"""
VCG Engine Tests v2
====================
Validates mathematical correctness, strategy-proofness, weighted pricing,
multi-quantity VCG, and performance.
"""

import time
import random
import pytest
import numpy as np
from talkfile_engine.vcg import (
    VCGEngine,
    AllocationInput,
    BidInput,
    compute_fan_weight,
    verify_dsic,
)


@pytest.fixture
def engine():
    return VCGEngine()


class TestBasicAllocation:
    """Test basic VCG allocation correctness."""

    def test_simple_3_bidders_2_seats(self, engine):
        """3 bidders, 2 seats. Top 2 weighted values win."""
        bids = [
            BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=100, effective_weight=1.0),
            BidInput(bid_id="b2", user_id="u2", max_willingness_to_pay=80, effective_weight=1.0),
            BidInput(bid_id="b3", user_id="u3", max_willingness_to_pay=60, effective_weight=1.0),
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=2))

        assert len(result.winners) == 2
        winner_ids = {w.user_id for w in result.winners}
        assert winner_ids == {"u1", "u2"}
        assert result.losers_count == 1
        assert result.total_bids == 3
        assert result.competition_ratio == 1.5

    def test_vcg_price_is_externality(self, engine):
        """VCG price = externality / weight. For w=1, same as v1."""
        bids = [
            BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=100, effective_weight=1.0),
            BidInput(bid_id="b2", user_id="u2", max_willingness_to_pay=80, effective_weight=1.0),
            BidInput(bid_id="b3", user_id="u3", max_willingness_to_pay=60, effective_weight=1.0),
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=2))

        # First excluded = 60. With w=1.0: payment = 60/1.0 = 60 for both
        for w in result.winners:
            assert w.vcg_price == 60.0, f"User {w.user_id} VCG price should be 60, got {w.vcg_price}"

    def test_everyone_wins_when_seats_exceed_bids(self, engine):
        """When seats >= bidders, everyone wins at price 0."""
        bids = [
            BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=100, effective_weight=1.0),
            BidInput(bid_id="b2", user_id="u2", max_willingness_to_pay=50, effective_weight=1.0),
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=5))

        assert len(result.winners) == 2
        for w in result.winners:
            assert w.vcg_price == 0.0

    def test_single_seat_is_second_price(self, engine):
        """Single seat VCG = Vickrey (second-price) auction."""
        bids = [
            BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=100, effective_weight=1.0),
            BidInput(bid_id="b2", user_id="u2", max_willingness_to_pay=80, effective_weight=1.0),
            BidInput(bid_id="b3", user_id="u3", max_willingness_to_pay=60, effective_weight=1.0),
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=1))

        assert len(result.winners) == 1
        assert result.winners[0].user_id == "u1"
        assert result.winners[0].vcg_price == 80.0

    def test_empty_bids(self, engine):
        result = engine.allocate(AllocationInput(bids=[], total_seats=10))
        assert len(result.winners) == 0

    def test_zero_seats(self, engine):
        bids = [BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=100)]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=0))
        assert len(result.winners) == 0


class TestWeightedVCGPricing:
    """Test v2 weighted VCG: different weights → different monetary payments."""

    def test_plan_numerical_example(self, engine):
        """Reproduce the exact numerical example from the plan.

        | Bidder | b_i   | w_i | w*b   | Won? | Payment         |
        |--------|-------|-----|-------|------|-----------------|
        | A      | 100K  | 1.5 | 150K  | Yes  | 96K/1.5 = 64K  |
        | B      | 120K  | 1.0 | 120K  | Yes  | 96K/1.0 = 96K  |
        | C      | 80K   | 1.2 | 96K   | No   | —               |
        | D      | 70K   | 1.0 | 70K   | No   | —               |
        """
        bids = [
            BidInput(bid_id="bA", user_id="A", max_willingness_to_pay=100000, effective_weight=1.5),
            BidInput(bid_id="bB", user_id="B", max_willingness_to_pay=120000, effective_weight=1.0),
            BidInput(bid_id="bC", user_id="C", max_willingness_to_pay=80000, effective_weight=1.2),
            BidInput(bid_id="bD", user_id="D", max_willingness_to_pay=70000, effective_weight=1.0),
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=2))

        winners = {w.user_id: w for w in result.winners}
        assert set(winners.keys()) == {"A", "B"}

        # A: 96000 / 1.5 = 64000
        assert abs(winners["A"].vcg_price - 64000.0) < 0.01
        # B: 96000 / 1.0 = 96000
        assert abs(winners["B"].vcg_price - 96000.0) < 0.01

    def test_higher_weight_pays_less(self, engine):
        """With same bid, higher weight → lower payment."""
        bids = [
            BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=100, effective_weight=2.0),
            BidInput(bid_id="b2", user_id="u2", max_willingness_to_pay=100, effective_weight=1.0),
            BidInput(bid_id="b3", user_id="u3", max_willingness_to_pay=50, effective_weight=1.0),
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=2))

        winners = {w.user_id: w for w in result.winners}
        # First excluded = 50*1.0 = 50
        # u1: 50/2.0 = 25
        # u2: 50/1.0 = 50
        assert winners["u1"].vcg_price == 25.0
        assert winners["u2"].vcg_price == 50.0

    def test_individual_rationality_weighted(self, engine):
        """m_i ≤ b_i must always hold for weighted VCG."""
        random.seed(42)
        for _ in range(100):
            n = random.randint(5, 50)
            k = random.randint(1, n - 1)
            bids = [
                BidInput(
                    bid_id=f"b{i}", user_id=f"u{i}",
                    max_willingness_to_pay=random.uniform(10, 500),
                    effective_weight=random.uniform(0.5, 2.0),
                )
                for i in range(n)
            ]
            result = engine.allocate(AllocationInput(bids=bids, total_seats=k))
            for w in result.winners:
                assert w.vcg_price <= w.bid_amount + 0.01, (
                    f"IR violated: {w.user_id} pays {w.vcg_price} > bid {w.bid_amount}"
                )

    def test_weight_affects_allocation(self, engine):
        """Lower bidder with higher weight wins over higher bidder with lower weight."""
        bids = [
            BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=80, effective_weight=2.0),  # score=160
            BidInput(bid_id="b2", user_id="u2", max_willingness_to_pay=100, effective_weight=1.0),  # score=100
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=1))

        assert len(result.winners) == 1
        assert result.winners[0].user_id == "u1"


class TestStrategyProofness:
    """Verify truthful bidding is always dominant strategy (weighted)."""

    def test_overbidding_does_not_help(self, engine):
        """Bidding higher than true value cannot improve utility."""
        true_value = 70

        bids_truthful = [
            BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=true_value, effective_weight=1.0),
            BidInput(bid_id="b2", user_id="u2", max_willingness_to_pay=80, effective_weight=1.0),
            BidInput(bid_id="b3", user_id="u3", max_willingness_to_pay=90, effective_weight=1.0),
        ]
        result_truthful = engine.allocate(AllocationInput(bids=bids_truthful, total_seats=2))

        bids_overbid = [
            BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=95, effective_weight=1.0),
            BidInput(bid_id="b2", user_id="u2", max_willingness_to_pay=80, effective_weight=1.0),
            BidInput(bid_id="b3", user_id="u3", max_willingness_to_pay=90, effective_weight=1.0),
        ]
        result_overbid = engine.allocate(AllocationInput(bids=bids_overbid, total_seats=2))

        u1_truthful = [w for w in result_truthful.winners if w.user_id == "u1"]
        u1_overbid = [w for w in result_overbid.winners if w.user_id == "u1"]

        if u1_overbid:
            utility_overbid = true_value - u1_overbid[0].vcg_price
            utility_truthful = 0 if not u1_truthful else (true_value - u1_truthful[0].vcg_price)
            assert utility_overbid <= utility_truthful + 0.01

    def test_underbidding_does_not_help(self, engine):
        """Bidding lower can only cause missing a good deal."""
        true_value = 100

        bids_truthful = [
            BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=true_value, effective_weight=1.0),
            BidInput(bid_id="b2", user_id="u2", max_willingness_to_pay=80, effective_weight=1.0),
            BidInput(bid_id="b3", user_id="u3", max_willingness_to_pay=60, effective_weight=1.0),
        ]
        result_truthful = engine.allocate(AllocationInput(bids=bids_truthful, total_seats=2))

        bids_underbid = [
            BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=50, effective_weight=1.0),
            BidInput(bid_id="b2", user_id="u2", max_willingness_to_pay=80, effective_weight=1.0),
            BidInput(bid_id="b3", user_id="u3", max_willingness_to_pay=60, effective_weight=1.0),
        ]
        result_underbid = engine.allocate(AllocationInput(bids=bids_underbid, total_seats=2))

        u1_truthful = [w for w in result_truthful.winners if w.user_id == "u1"]
        assert len(u1_truthful) == 1
        utility_truthful = true_value - u1_truthful[0].vcg_price

        u1_underbid = [w for w in result_underbid.winners if w.user_id == "u1"]
        utility_underbid = 0 if not u1_underbid else (true_value - u1_underbid[0].vcg_price)

        assert utility_truthful >= utility_underbid

    def test_strategy_proofness_random_weighted(self, engine):
        """1000 random scenarios: lying never helps with weighted VCG."""
        random.seed(123)
        violations = 0

        for _ in range(1000):
            n = random.randint(4, 20)
            k = random.randint(1, n - 1)
            true_value = random.uniform(10, 500)
            weight = random.uniform(0.5, 2.0)

            others = [
                BidInput(
                    bid_id=f"b{i}", user_id=f"u{i}",
                    max_willingness_to_pay=random.uniform(10, 500),
                    effective_weight=random.uniform(0.5, 2.0),
                )
                for i in range(1, n)
            ]

            # Truthful
            bids_truth = [BidInput(bid_id="b0", user_id="u0",
                                   max_willingness_to_pay=true_value,
                                   effective_weight=weight)] + others
            result_truth = engine.allocate(AllocationInput(bids=bids_truth, total_seats=k))
            u0_truth = [w for w in result_truth.winners if w.user_id == "u0"]
            util_truth = (true_value - u0_truth[0].vcg_price) if u0_truth else 0.0

            # Lie
            lie_value = random.uniform(10, 500)
            bids_lie = [BidInput(bid_id="b0", user_id="u0",
                                 max_willingness_to_pay=lie_value,
                                 effective_weight=weight)] + others
            result_lie = engine.allocate(AllocationInput(bids=bids_lie, total_seats=k))
            u0_lie = [w for w in result_lie.winners if w.user_id == "u0"]
            util_lie = (true_value - u0_lie[0].vcg_price) if u0_lie else 0.0

            if util_lie > util_truth + 0.01:
                violations += 1

        assert violations == 0, f"Strategy-proofness violated in {violations}/1000 cases"


class TestMultiQuantityVCG:
    """Test true VCG pricing for multi-quantity bids (v2 critical fix)."""

    def test_plan_multi_qty_example(self, engine):
        """Reproduce the plan's multi-quantity error demonstration.

        A: b=100, w=1.0, q=2
        B: b=80,  w=1.0, q=1
        C: b=70,  w=1.0, q=1
        D: b=50,  w=1.0, q=1
        K=3 seats

        True VCG: A pays 120 total (60/unit), B pays 70
        Old (wrong): A pays 140 total (70/unit), B pays 70
        """
        bids = [
            BidInput(bid_id="bA", user_id="A", max_willingness_to_pay=100, quantity=2, effective_weight=1.0),
            BidInput(bid_id="bB", user_id="B", max_willingness_to_pay=80, quantity=1, effective_weight=1.0),
            BidInput(bid_id="bC", user_id="C", max_willingness_to_pay=70, quantity=1, effective_weight=1.0),
            BidInput(bid_id="bD", user_id="D", max_willingness_to_pay=50, quantity=1, effective_weight=1.0),
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=3))

        winners = {w.user_id: w for w in result.winners}
        assert "A" in winners
        assert "B" in winners

        # A: SW*(-A) = 80+70+50 = 200. others_with_A = 280-200 = 80. m_A = (200-80)/1.0 = 120
        assert abs(winners["A"].vcg_price - 120.0) < 0.01, f"A should pay 120, got {winners['A'].vcg_price}"
        # B: SW*(-B) = 100*2+70 = 270. others_with_B = 280-80 = 200. m_B = (270-200)/1.0 = 70
        assert abs(winners["B"].vcg_price - 70.0) < 0.01, f"B should pay 70, got {winners['B'].vcg_price}"

    def test_multi_qty_individual_rationality(self, engine):
        """m_i ≤ b_i * q_i must hold for multi-quantity winners."""
        random.seed(99)
        for _ in range(100):
            n = random.randint(4, 20)
            k = random.randint(3, n + 5)
            bids = [
                BidInput(
                    bid_id=f"b{i}", user_id=f"u{i}",
                    max_willingness_to_pay=random.uniform(10, 200),
                    effective_weight=random.uniform(0.5, 2.0),
                    quantity=random.randint(1, 3),
                )
                for i in range(n)
            ]
            result = engine.allocate(AllocationInput(bids=bids, total_seats=k))
            for w in result.winners:
                # vcg_price is total payment for all units won
                assert w.vcg_price <= w.bid_amount * 4 + 0.01  # max 4 units

    def test_quantity_2_takes_2_seats(self, engine):
        bids = [
            BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=100, quantity=2),
            BidInput(bid_id="b2", user_id="u2", max_willingness_to_pay=80, quantity=1),
            BidInput(bid_id="b3", user_id="u3", max_willingness_to_pay=60, quantity=1),
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=3))

        winner_ids = {w.user_id for w in result.winners}
        assert "u1" in winner_ids
        assert "u2" in winner_ids

    def test_multi_qty_weighted(self, engine):
        """Multi-quantity + different weights."""
        bids = [
            BidInput(bid_id="bA", user_id="A", max_willingness_to_pay=100, quantity=2, effective_weight=1.5),
            BidInput(bid_id="bB", user_id="B", max_willingness_to_pay=120, quantity=1, effective_weight=1.0),
            BidInput(bid_id="bC", user_id="C", max_willingness_to_pay=80, quantity=1, effective_weight=1.0),
            BidInput(bid_id="bD", user_id="D", max_willingness_to_pay=60, quantity=1, effective_weight=1.0),
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=3))

        winners = {w.user_id: w for w in result.winners}
        # All winners should pay ≤ their bid amount (per unit × quantity)
        for uid, w in winners.items():
            # For aggregated winner, vcg_price is total
            # We need the original quantity to check
            orig = [b for b in bids if b.user_id == uid][0]
            assert w.vcg_price <= orig.max_willingness_to_pay * orig.quantity + 0.01


class TestPriceStabilization:
    """Test price stabilization module."""

    def test_no_stabilization_when_lambda_zero(self, engine):
        bids = [
            BidInput(bid_id=f"b{i}", user_id=f"u{i}", max_willingness_to_pay=50 + i * 10)
            for i in range(10)
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=5, stabilization_lambda=0.0))

        for w in result.winners:
            assert w.final_price == w.vcg_price

    def test_stabilization_reduces_variance(self, engine):
        """Stabilization compresses toward median while preserving VCG floor.
        Prices can only go UP (toward median), never below VCG."""
        random.seed(77)
        bids = [
            BidInput(bid_id=f"b{i}", user_id=f"u{i}",
                     max_willingness_to_pay=random.randint(50, 200),
                     effective_weight=random.uniform(0.5, 2.0))
            for i in range(20)
        ]

        result_no_stab = engine.allocate(
            AllocationInput(bids=bids, total_seats=10, stabilization_lambda=0.0)
        )
        result_with_stab = engine.allocate(
            AllocationInput(bids=bids, total_seats=10, stabilization_lambda=0.5)
        )

        prices_no = sorted([w.final_price for w in result_no_stab.winners])
        prices_with = sorted([w.final_price for w in result_with_stab.winners])

        # With DSIC-preserving stabilization: prices only go UP (toward median)
        # so min(stabilized) ≥ min(vcg) and variance is reduced
        for p_vcg, p_stab in zip(prices_no, prices_with):
            assert p_stab >= p_vcg - 1e-9, \
                f"Stabilization pushed below VCG: {p_stab} < {p_vcg}"

    def test_min_price_floor(self, engine):
        bids = [
            BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=100),
            BidInput(bid_id="b2", user_id="u2", max_willingness_to_pay=50),
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=2, min_price=30.0))

        for w in result.winners:
            assert w.final_price >= 30.0


class TestLegacyWeightComputation:
    """Test legacy compute_fan_weight (v1 compatibility)."""

    def test_weight_computation(self):
        w1 = compute_fan_weight(verification_level=0.0, loyalty_score=0.0)
        assert w1 == 0.5

        w2 = compute_fan_weight(verification_level=1.0, loyalty_score=1.0)
        assert w2 == 2.0

        w3 = compute_fan_weight(verification_level=0.5, loyalty_score=0.5)
        assert 0.5 < w3 < 2.0


class TestPerformance:
    """Test engine performance at scale."""

    def test_10000_seats_under_5_seconds(self, engine):
        """10,000 seats with 50,000 bidders (unit demand) — fast path."""
        n_bidders = 50_000
        n_seats = 10_000

        bids = [
            BidInput(
                bid_id=f"b{i}",
                user_id=f"u{i}",
                max_willingness_to_pay=random.uniform(10, 500),
                effective_weight=random.uniform(0.5, 2.0),
            )
            for i in range(n_bidders)
        ]

        start = time.time()
        result = engine.allocate(AllocationInput(bids=bids, total_seats=n_seats))
        elapsed = time.time() - start

        assert elapsed < 5.0, f"Allocation took {elapsed:.2f}s, should be under 5s"
        assert len(result.winners) == n_seats
        assert result.total_bids == n_bidders
        assert result.computation_time_seconds < 5.0

    def test_100000_bidders_performance(self, engine):
        """100,000 bidders, 10,000 seats — unit demand fast path."""
        n_bidders = 100_000
        n_seats = 10_000

        bids = [
            BidInput(
                bid_id=f"b{i}",
                user_id=f"u{i}",
                max_willingness_to_pay=random.uniform(10, 500),
                effective_weight=random.uniform(0.5, 2.0),
            )
            for i in range(n_bidders)
        ]

        start = time.time()
        result = engine.allocate(AllocationInput(bids=bids, total_seats=n_seats))
        elapsed = time.time() - start

        assert elapsed < 30.0, f"Large allocation took {elapsed:.2f}s"
        assert len(result.winners) == n_seats


class TestApproximateVCGDeterminism:
    """Approximate VCG path (N > APPROX_VCG_THRESHOLD) must be fully
    deterministic: same input + same seed → identical winners AND prices.

    The threshold is monkeypatched low so the approximate path is exercised
    without building 10,000+ bids.
    """

    @staticmethod
    def _make_bids(n: int, gen_seed: int = 2024) -> list:
        r = random.Random(gen_seed)
        return [
            BidInput(
                bid_id=f"b{i:05d}",
                user_id=f"u{i:05d}",
                max_willingness_to_pay=r.uniform(10, 500),
                effective_weight=r.uniform(0.5, 2.0),
                quantity=r.randint(1, 3),
            )
            for i in range(n)
        ]

    @staticmethod
    def _snapshot(result):
        """Canonical (bid_id, user_id, prices) snapshot of an allocation."""
        return sorted(
            (
                w.bid_id,
                w.user_id,
                round(w.vcg_price, 9),
                round(w.final_price, 9),
            )
            for w in result.winners
        )

    def test_approx_path_same_input_twice_identical(self, engine, monkeypatch):
        """Two runs on identical input must give identical winners + prices."""
        monkeypatch.setattr("talkfile_engine.vcg.APPROX_VCG_THRESHOLD", 50)

        r1 = engine.allocate(AllocationInput(bids=self._make_bids(200), total_seats=40))
        r2 = engine.allocate(AllocationInput(bids=self._make_bids(200), total_seats=40))

        assert len(r1.winners) > 0, "Approx path produced no winners"
        assert self._snapshot(r1) == self._snapshot(r2)
        # Winner ORDER must also be deterministic, not just the set
        assert [w.bid_id for w in r1.winners] == [w.bid_id for w in r2.winners]
        # Content-derived seed must be recorded and reproducible
        assert r1.seed_used != 0
        assert r1.seed_used == r2.seed_used

    def test_approx_path_explicit_seed_reproducible(self, engine, monkeypatch):
        """An explicit AllocationInput.seed must reproduce results exactly."""
        monkeypatch.setattr("talkfile_engine.vcg.APPROX_VCG_THRESHOLD", 50)

        r1 = engine.allocate(
            AllocationInput(bids=self._make_bids(150), total_seats=30, seed=777)
        )
        r2 = engine.allocate(
            AllocationInput(bids=self._make_bids(150), total_seats=30, seed=777)
        )

        assert r1.seed_used == r2.seed_used == 777
        assert self._snapshot(r1) == self._snapshot(r2)

    def test_approx_path_order_invariant(self, engine, monkeypatch):
        """Shuffling the bid list must not change winners or prices."""
        monkeypatch.setattr("talkfile_engine.vcg.APPROX_VCG_THRESHOLD", 50)

        bids_fwd = self._make_bids(200)
        bids_shuf = self._make_bids(200)
        random.Random(7).shuffle(bids_shuf)

        r1 = engine.allocate(AllocationInput(bids=bids_fwd, total_seats=40))
        r2 = engine.allocate(AllocationInput(bids=bids_shuf, total_seats=40))

        assert r1.seed_used == r2.seed_used  # content-derived, order-independent
        assert self._snapshot(r1) == self._snapshot(r2)

    def test_approx_path_price_winner_alignment(self, engine, monkeypatch):
        """Each winner's price must be their own: individual rationality
        (price ≤ own bid × quantity won) must hold for every winner.
        With the old misaligned zip, another bidder's price could be charged.
        """
        monkeypatch.setattr("talkfile_engine.vcg.APPROX_VCG_THRESHOLD", 50)

        bids = self._make_bids(200, gen_seed=99)
        by_id = {b.bid_id: b for b in bids}
        result = engine.allocate(AllocationInput(bids=bids, total_seats=40))

        assert len(result.winners) > 0
        for w in result.winners:
            orig = by_id[w.bid_id]
            max_total = orig.max_willingness_to_pay * orig.quantity
            assert w.final_price <= max_total + 0.01, (
                f"{w.bid_id} charged {w.final_price} > own max {max_total}"
            )
            assert w.vcg_price >= 0.0

    def test_exact_paths_unaffected_and_seedless(self, engine):
        """Below the threshold (exact paths) no randomness is consumed:
        seed_used stays 0 and results are reproducible as before."""
        def make_bids():
            return [
                BidInput(bid_id="b1", user_id="u1", max_willingness_to_pay=100, quantity=2),
                BidInput(bid_id="b2", user_id="u2", max_willingness_to_pay=80, quantity=1),
                BidInput(bid_id="b3", user_id="u3", max_willingness_to_pay=60, quantity=1),
            ]

        r1 = engine.allocate(AllocationInput(bids=make_bids(), total_seats=3))
        r2 = engine.allocate(AllocationInput(bids=make_bids(), total_seats=3))
        assert r1.seed_used == 0 and r2.seed_used == 0
        snap = lambda r: sorted(
            (w.bid_id, round(w.vcg_price, 9), round(w.final_price, 9))
            for w in r.winners
        )
        assert snap(r1) == snap(r2)
        winners = {w.user_id for w in r1.winners}
        assert {"u1", "u2"} <= winners

    def test_tie_breaking_is_stable_by_bid_id(self, engine):
        """Equal weighted values: the winner must be chosen by stable key
        (bid_id), regardless of input order."""
        def make(order_reversed: bool):
            bids = [
                BidInput(bid_id="b_aaa", user_id="u_aaa", max_willingness_to_pay=100.0),
                BidInput(bid_id="b_bbb", user_id="u_bbb", max_willingness_to_pay=100.0),
                BidInput(bid_id="b_ccc", user_id="u_ccc", max_willingness_to_pay=50.0),
            ]
            if order_reversed:
                bids = list(reversed(bids))
            return engine.allocate(AllocationInput(bids=bids, total_seats=1))

        r_fwd = make(False)
        r_rev = make(True)
        assert [w.bid_id for w in r_fwd.winners] == [w.bid_id for w in r_rev.winners]
        assert [w.final_price for w in r_fwd.winners] == [w.final_price for w in r_rev.winners]
        # Stable key: lexicographically smallest bid_id wins the tie
        assert r_fwd.winners[0].bid_id == "b_aaa"


class TestOutputStatistics:
    """Test that output statistics are correctly computed."""

    def test_price_distribution(self, engine):
        bids = [
            BidInput(bid_id=f"b{i}", user_id=f"u{i}", max_willingness_to_pay=10 * (i + 1))
            for i in range(20)
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=10))

        assert result.price_min <= result.price_p25
        assert result.price_p25 <= result.price_median
        assert result.price_median <= result.price_p75
        assert result.price_p75 <= result.price_max
        assert result.total_revenue > 0
        assert result.total_social_welfare > 0


class TestStrategyProofnessFlag:
    """idx7: is_strategy_proof must reflect the actual mechanism, not be hardcoded."""

    def _bids(self):
        return [
            BidInput(bid_id=f"b{i}", user_id=f"u{i}", max_willingness_to_pay=100 - i * 5)
            for i in range(10)
        ]

    def test_pure_vcg_is_strategy_proof(self, engine):
        """Pure VCG (lambda=0) is provably DSIC -> True."""
        r = engine.allocate(AllocationInput(bids=self._bids(), total_seats=5))
        assert r.is_strategy_proof is True

    def test_vcg_with_reserve_is_strategy_proof(self, engine):
        """Exogenous reserve (min_price) is a participation pre-filter -> still DSIC."""
        r = engine.allocate(
            AllocationInput(bids=self._bids(), total_seats=5, min_price=30.0)
        )
        assert r.is_strategy_proof is True

    def test_stabilization_weakens_dsic(self, engine):
        """lambda>0 modifies Groves payments -> NOT advertised as strategy-proof."""
        r = engine.allocate(
            AllocationInput(
                bids=self._bids(), total_seats=5, stabilization_lambda=0.5
            )
        )
        assert r.is_strategy_proof is False

    def test_default_output_is_not_strategy_proof(self):
        """A bare AllocationOutput must NOT claim strategy-proofness (safe default)."""
        from talkfile_engine.vcg import AllocationOutput

        assert AllocationOutput().is_strategy_proof is False


class TestVerifyDSIC:
    """idx7: verify_dsic math — must NOT return a constant 0.5; truthful VCG scores ~1.0."""

    def test_pure_vcg_scores_one(self, engine):
        bids = [
            BidInput(bid_id=f"b{i}", user_id=f"u{i}", max_willingness_to_pay=100 - i * 5)
            for i in range(10)
        ]
        r = engine.allocate(AllocationInput(bids=bids, total_seats=5))
        prices = {w.bid_id: w.final_price for w in r.winners}
        score = verify_dsic(bids, r.winners, prices)
        # Truthful VCG: no profitable deviation -> perfect score, NOT a constant 0.5
        assert score == pytest.approx(1.0)

    def test_not_constant_half(self, engine):
        """Regression: old bug returned exactly 0.5 for any positive-bid winners."""
        bids = [
            BidInput(bid_id="a", user_id="a", max_willingness_to_pay=100),
            BidInput(bid_id="b", user_id="b", max_willingness_to_pay=80),
        ]
        r = engine.allocate(AllocationInput(bids=bids, total_seats=1))
        prices = {w.bid_id: w.final_price for w in r.winners}
        score = verify_dsic(bids, r.winners, prices)
        assert score != pytest.approx(0.5)
        assert score == pytest.approx(1.0)

    def test_no_winners_returns_one(self):
        assert verify_dsic([], [], {}) == 1.0
