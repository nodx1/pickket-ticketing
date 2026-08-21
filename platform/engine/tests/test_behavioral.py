"""
Behavioral & Explanation Tests
=================================
Tests for Phase 3 (behavioral metrics) and Phase 4 (explanation engine).
Also covers Phase 6 (collusion detection).
"""

import random as rng
import pytest
from talkfile_engine.vcg import VCGEngine, AllocationInput, BidInput
from talkfile_engine.explanation import AllocationExplainer, WinnerExplanation, LoserExplanation
from talkfile_engine.eligibility import (
    CollusionSignal, detect_collusion_signals,
)


# ─── Behavioral Metrics (Phase 3) ───


class TestBehavioralMetrics:

    def _run_basic_allocation(self, n_bids=50, n_seats=10, seed=42):
        rng.seed(seed)
        engine = VCGEngine()
        bids = [
            BidInput(f"b{i}", f"u{i}", rng.uniform(50000, 200000), rng.uniform(0.6, 1.8), 1)
            for i in range(n_bids)
        ]
        return engine.allocate(AllocationInput(bids=bids, total_seats=n_seats))

    def test_consumer_surplus_non_negative(self):
        result = self._run_basic_allocation()
        assert result.total_consumer_surplus >= 0

    def test_avg_surplus_ratio_bounded(self):
        result = self._run_basic_allocation()
        assert 0.0 <= result.avg_surplus_ratio <= 1.0

    def test_overbidding_indicator_above_one(self):
        """Median bid should generally exceed median price (users overbid)."""
        result = self._run_basic_allocation()
        assert result.overbidding_indicator >= 1.0

    def test_gini_bounded(self):
        result = self._run_basic_allocation()
        assert 0.0 <= result.gini_coefficient <= 1.0

    def test_price_ratio_max_above_one(self):
        result = self._run_basic_allocation()
        assert result.price_ratio_max >= 1.0

    def test_weight_price_negative_correlation(self):
        """Higher weight → lower price → negative correlation."""
        result = self._run_basic_allocation(n_bids=200, n_seats=50)
        # With diverse weights, correlation should be negative
        assert result.weight_price_correlation < 0

    def test_everyone_wins_surplus(self):
        """When everyone wins (price=0), surplus equals total bid amounts."""
        engine = VCGEngine()
        bids = [
            BidInput(f"b{i}", f"u{i}", 100000, 1.0, 1)
            for i in range(5)
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=10))
        # All win with price 0
        assert result.total_consumer_surplus == pytest.approx(500000, abs=1)

    def test_single_winner_metrics(self):
        """Single winner should have valid metrics."""
        engine = VCGEngine()
        bids = [
            BidInput("b1", "u1", 100000, 1.0, 1),
            BidInput("b2", "u2", 80000, 1.0, 1),
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=1))
        assert result.gini_coefficient == 0.0  # Single price → Gini=0
        assert result.price_ratio_max == 1.0

    def test_resale_risk_high_margin_low_weight(self):
        """Low weight + high margin → high resale risk."""
        engine = VCGEngine()
        bids = [
            BidInput("b1", "u1", 200000, 0.6, 1),  # Low weight, big margin
            BidInput("b2", "u2", 150000, 1.8, 1),   # High weight
            BidInput("b3", "u3", 100000, 1.0, 1),    # Loser
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=2))
        winners = {w.user_id: w for w in result.winners}
        # u1 (low weight) should have higher resale risk than u2 (high weight)
        assert winners["u1"].resale_risk_score >= winners["u2"].resale_risk_score


# ─── Explanation Engine (Phase 4) ───


class TestWinnerExplanation:

    def _setup_allocation(self):
        engine = VCGEngine()
        bids = [
            BidInput("b1", "u1", 150000, 1.5, 1),
            BidInput("b2", "u2", 120000, 1.0, 1),
            BidInput("b3", "u3", 100000, 1.2, 1),
            BidInput("b4", "u4", 80000, 1.0, 1),  # Loser
        ]
        return engine.allocate(AllocationInput(bids=bids, total_seats=3))

    def test_price_percentile_computed(self):
        result = self._setup_allocation()
        explainer = AllocationExplainer()
        for w in result.winners:
            exp = explainer.explain_winner(w, result)
            assert 0 <= exp.price_percentile <= 100

    def test_weight_effect_non_negative(self):
        result = self._setup_allocation()
        explainer = AllocationExplainer()
        for w in result.winners:
            exp = explainer.explain_winner(w, result)
            assert exp.weight_effect_pct >= 0

    def test_savings_vs_uniform_non_negative(self):
        result = self._setup_allocation()
        explainer = AllocationExplainer()
        for w in result.winners:
            exp = explainer.explain_winner(w, result)
            assert exp.savings_vs_uniform >= 0

    def test_consumer_surplus_matches(self):
        result = self._setup_allocation()
        explainer = AllocationExplainer()
        for w in result.winners:
            exp = explainer.explain_winner(w, result)
            expected = w.bid_amount - w.final_price
            assert exp.consumer_surplus == pytest.approx(expected, abs=0.1)

    def test_fairness_statement_is_string(self):
        result = self._setup_allocation()
        explainer = AllocationExplainer()
        for w in result.winners:
            exp = explainer.explain_winner(w, result)
            assert isinstance(exp.fairness_statement, str)
            assert len(exp.fairness_statement) > 0

    def test_high_weight_winner_gets_savings(self):
        """Winner with weight > 1.0 should see savings vs uniform."""
        result = self._setup_allocation()
        explainer = AllocationExplainer()
        # u1 has w=1.5
        u1 = [w for w in result.winners if w.user_id == "u1"][0]
        exp = explainer.explain_winner(u1, result)
        assert exp.weight_effect_pct > 0
        assert exp.savings_vs_uniform > 0


class TestLoserExplanation:

    def _setup_allocation(self):
        engine = VCGEngine()
        bids = [
            BidInput("b1", "u1", 150000, 1.5, 1),
            BidInput("b2", "u2", 120000, 1.0, 1),
            BidInput("b3", "u3", 80000, 1.0, 1),  # Loser
        ]
        return engine.allocate(AllocationInput(bids=bids, total_seats=2))

    def test_margin_to_win_computed(self):
        result = self._setup_allocation()
        explainer = AllocationExplainer()
        # u3 lost with bid=80000, w=1.0
        exp = explainer.explain_loser(80000, 1.0, result)
        assert exp.margin_to_win is not None
        assert exp.margin_to_win > 0

    def test_narrow_miss_detection(self):
        """Bid very close to cutoff should be narrow miss."""
        engine = VCGEngine()
        bids = [
            BidInput("b1", "u1", 100000, 1.0, 1),
            BidInput("b2", "u2", 99000, 1.0, 1),
            BidInput("b3", "u3", 98500, 1.0, 1),  # Just barely loses
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=2))
        explainer = AllocationExplainer()
        # u3 barely lost
        exp = explainer.explain_loser(98500, 1.0, result)
        assert exp.was_narrow_miss

    def test_not_narrow_miss_for_low_bid(self):
        """Bid far from cutoff should NOT be narrow miss."""
        engine = VCGEngine()
        bids = [
            BidInput("b1", "u1", 200000, 1.0, 1),
            BidInput("b2", "u2", 150000, 1.0, 1),
            BidInput("b3", "u3", 50000, 1.0, 1),  # Far from cutoff
        ]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=2))
        explainer = AllocationExplainer()
        exp = explainer.explain_loser(50000, 1.0, result)
        assert not exp.was_narrow_miss

    def test_constructive_note_is_string(self):
        result = self._setup_allocation()
        explainer = AllocationExplainer()
        exp = explainer.explain_loser(80000, 1.0, result)
        assert isinstance(exp.constructive_note, str)
        assert len(exp.constructive_note) > 0

    def test_low_weight_gets_weight_advice(self):
        """Loser with weight < 1.0 should get weight improvement advice."""
        result = self._setup_allocation()
        explainer = AllocationExplainer()
        exp = explainer.explain_loser(80000, 0.7, result)
        assert "verification" in exp.constructive_note.lower() or "weight" in exp.constructive_note.lower()


class TestExplanationEdgeCases:

    def test_everyone_wins_explanation(self):
        """When everyone wins (price=0), explanation should still work."""
        engine = VCGEngine()
        bids = [BidInput(f"b{i}", f"u{i}", 100000, 1.0, 1) for i in range(3)]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=5))

        explainer = AllocationExplainer()
        for w in result.winners:
            exp = explainer.explain_winner(w, result)
            assert exp.consumer_surplus == pytest.approx(100000, abs=1)

    def test_single_winner_explanation(self):
        """Single winner with single bid."""
        engine = VCGEngine()
        bids = [BidInput("b1", "u1", 100000, 1.0, 1)]
        result = engine.allocate(AllocationInput(bids=bids, total_seats=1))

        explainer = AllocationExplainer()
        exp = explainer.explain_winner(result.winners[0], result)
        assert exp.price_percentile == 0.0  # Single winner: 0th percentile (no one cheaper or more expensive)


# ─── Collusion Detection (Phase 6) ───


class TestCollusionDetection:

    def test_identical_bids_high_similarity(self):
        """10 users bidding exact same amount → high similarity score."""
        bids = [
            {"user_id": f"u{i}", "bid_amount": 100000, "submit_time": float(i * 100)}
            for i in range(10)
        ]
        sig = detect_collusion_signals(bids, 100)
        assert sig.bid_similarity_score > 0.5

    def test_diverse_bids_low_similarity(self):
        """Diverse bid amounts → low similarity score."""
        rng.seed(99)
        bids = [
            {"user_id": f"u{i}", "bid_amount": rng.uniform(50000, 200000), "submit_time": float(i * 60)}
            for i in range(100)
        ]
        sig = detect_collusion_signals(bids, 100)
        assert sig.bid_similarity_score < 0.3

    def test_timing_cluster_high_score(self):
        """5 bids within 1 second → high timing score."""
        bids = [
            {"user_id": f"u{i}", "bid_amount": i * 10000, "submit_time": 1000.0 + i * 0.1}
            for i in range(5)
        ]
        sig = detect_collusion_signals(bids, 100)
        assert sig.timing_cluster_score > 0.5

    def test_spread_timing_low_score(self):
        """Bids spread over hours → low timing score."""
        bids = [
            {"user_id": f"u{i}", "bid_amount": i * 10000, "submit_time": float(i * 3600)}
            for i in range(20)
        ]
        sig = detect_collusion_signals(bids, 100)
        assert sig.timing_cluster_score < 0.3

    def test_shared_payment_method(self):
        """Multiple users with same payment hash → high payment score."""
        bids = [
            {"user_id": f"u{i}", "bid_amount": i * 10000, "submit_time": float(i * 100),
             "payment_method_hash": "same_card_hash"}
            for i in range(5)
        ]
        sig = detect_collusion_signals(bids, 100)
        assert sig.payment_cluster_score > 0.3

    def test_unique_payment_methods_low_score(self):
        """All different payment methods → low payment score."""
        bids = [
            {"user_id": f"u{i}", "bid_amount": i * 10000, "submit_time": float(i * 100),
             "payment_method_hash": f"card_{i}"}
            for i in range(20)
        ]
        sig = detect_collusion_signals(bids, 100)
        assert sig.payment_cluster_score == 0.0

    def test_empty_bids_returns_zero(self):
        sig = detect_collusion_signals([], 100)
        assert sig.overall_score == 0.0

    def test_overall_score_bounded(self):
        """Overall score should be in [0, 1]."""
        rng.seed(77)
        for _ in range(10):
            n = rng.randint(5, 50)
            bids = [
                {"user_id": f"u{i}", "bid_amount": rng.uniform(10000, 200000),
                 "submit_time": rng.uniform(0, 86400),
                 "payment_method_hash": f"card_{rng.randint(0, 3)}"}
                for i in range(n)
            ]
            sig = detect_collusion_signals(bids, 100)
            assert 0.0 <= sig.overall_score <= 1.0

    def test_no_payment_hash_graceful(self):
        """Bids without payment_method_hash should not crash."""
        bids = [
            {"user_id": f"u{i}", "bid_amount": i * 10000, "submit_time": float(i)}
            for i in range(10)
        ]
        sig = detect_collusion_signals(bids, 100)
        assert sig.payment_cluster_score == 0.0

    def test_round_number_discounted(self):
        """Moderate cluster at round number (150k) should have LOW similarity."""
        # n=500, √n≈22.4, cluster=30 (just above threshold)
        # raw_similarity = (30-22.4)/22.4 ≈ 0.34
        # roundness(150000)=2.5 → discounted = 0.34/2.5 ≈ 0.14
        bids = [
            {"user_id": f"u{i}", "bid_amount": 150000, "submit_time": float(i * 60)}
            for i in range(30)
        ] + [
            {"user_id": f"v{i}", "bid_amount": 80000 + i * 300, "submit_time": float(i * 60)}
            for i in range(470)
        ]
        sig = detect_collusion_signals(bids, 100)
        assert sig.bid_similarity_score < 0.3

    def test_non_round_number_higher_than_round(self):
        """Same cluster size at non-round number should score higher than round."""
        # Non-round: 30/500 at 153847
        bids_nonround = [
            {"user_id": f"u{i}", "bid_amount": 153847, "submit_time": float(i * 60)}
            for i in range(30)
        ] + [
            {"user_id": f"v{i}", "bid_amount": 80000 + i * 300, "submit_time": float(i * 60)}
            for i in range(470)
        ]
        sig_nonround = detect_collusion_signals(bids_nonround, 100)

        # Round: 30/500 at 150000
        bids_round = [
            {"user_id": f"u{i}", "bid_amount": 150000, "submit_time": float(i * 60)}
            for i in range(30)
        ] + [
            {"user_id": f"v{i}", "bid_amount": 80000 + i * 300, "submit_time": float(i * 60)}
            for i in range(470)
        ]
        sig_round = detect_collusion_signals(bids_round, 100)

        # Non-round cluster is more suspicious than round cluster
        assert sig_nonround.bid_similarity_score > sig_round.bid_similarity_score
