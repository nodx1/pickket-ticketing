"""
TalkFile Adversarial Attack Suite
==================================
Systematically attempt to break every mathematical property.

Attack categories:
  1. VCG Strategy-Proofness — lying, collusion, sybil
  2. Individual Rationality — m_i > b_i violations
  3. Fan Weight Gaming — dimension manipulation, sigmoid exploits
  4. Multi-Pool Cross-Strategy — pool hopping, free-riding
  5. Numerical Instability — overflow, zero division, extreme inputs
  6. Multi-Quantity Edge Cases — full-seat monopoly, q=K
"""

import math
import random
import pytest
import numpy as np

from talkfile_engine.vcg import VCGEngine, BidInput, AllocationInput
from talkfile_engine.fan_weight import (
    compute_fan_weight_v2, FanScores, AlphaWeights,
    compute_raw_score, sigmoid, compute_history_score,
    compute_behavior_score, compute_freshness_score,
    compute_loyalty_score,
    KAPPA, MU, W_MIN, W_SCALE, ALPHA_MIN, ALPHA_MAX, ALPHA_MAX_BINARY,
    EVENT_TEMPLATES, EventType, DECAY_LAMBDA,
)
from talkfile_engine.eligibility import (
    check_eligibility, compute_pool_seats, compute_abuse_score,
    UserEligibility, VerificationLevel, Pool,
    ABUSE_THRESHOLD, DEFAULT_POOL_RATIOS,
)


engine = VCGEngine()


# ============================================================
# Attack 1: VCG Strategy-Proofness Breaking Attempts
# ============================================================

class TestAttackStrategyProofness:
    """Try every known strategy to profit from lying."""

    def test_attack_overbid_with_high_weight(self):
        """Attack: High-weight user overbids massively.
        Hypothesis: with w=1.93, overbidding from 100 to 1M might help."""
        bids_truth = [
            BidInput("a", "u1", 100.0, 1.93),
            BidInput("b", "u2", 200.0, 1.0),
            BidInput("c", "u3", 150.0, 1.0),
        ]
        bids_lie = [
            BidInput("a", "u1", 1_000_000.0, 1.93),  # massive overbid
            BidInput("b", "u2", 200.0, 1.0),
            BidInput("c", "u3", 150.0, 1.0),
        ]
        inp_truth = AllocationInput(bids=bids_truth, total_seats=2)
        inp_lie = AllocationInput(bids=bids_lie, total_seats=2)

        out_truth = engine.allocate(inp_truth)
        out_lie = engine.allocate(inp_lie)

        # Find u1's utility in both
        u1_truth = None
        for w in out_truth.winners:
            if w.user_id == "u1":
                u1_truth = 100.0 - w.final_price  # true valuation - payment

        u1_lie = None
        for w in out_lie.winners:
            if w.user_id == "u1":
                u1_lie = 100.0 - w.final_price  # true valuation (100) - payment

        # Overbidding should never increase utility
        if u1_truth is not None and u1_lie is not None:
            assert u1_truth >= u1_lie - 1e-9, \
                f"BROKEN! Overbid profit: truth={u1_truth:.4f}, lie={u1_lie:.4f}"
        elif u1_truth is not None and u1_lie is None:
            # Won truthfully but lost by lying — worse
            pass
        elif u1_truth is None and u1_lie is not None:
            # Didn't win truthfully, but won by lying — check if profitable
            # Payment might exceed true value (100)
            assert u1_lie <= 1e-9, \
                f"BROKEN! Overbid gained winning + positive utility: {u1_lie:.4f}"

    def test_attack_underbid_to_reduce_price(self):
        """Attack: Underbid to get a lower price while still winning.
        In VCG, underbidding can only cause you to lose."""
        bids_truth = [
            BidInput("a", "u1", 500.0, 1.0),
            BidInput("b", "u2", 300.0, 1.0),
            BidInput("c", "u3", 200.0, 1.0),
        ]
        # u1 underbids: 500 -> 250 (still above cutoff 200)
        bids_lie = [
            BidInput("a", "u1", 250.0, 1.0),
            BidInput("b", "u2", 300.0, 1.0),
            BidInput("c", "u3", 200.0, 1.0),
        ]
        inp_truth = AllocationInput(bids=bids_truth, total_seats=2)
        inp_lie = AllocationInput(bids=bids_lie, total_seats=2)

        out_truth = engine.allocate(inp_truth)
        out_lie = engine.allocate(inp_lie)

        # u1 should pay the same in both (payment depends on others)
        u1_price_truth = next(w.final_price for w in out_truth.winners if w.user_id == "u1")
        u1_price_lie = next(w.final_price for w in out_lie.winners if w.user_id == "u1")

        # Prices must be equal — VCG price depends on OTHERS, not own bid
        assert abs(u1_price_truth - u1_price_lie) < 1e-9, \
            f"BROKEN! Underbid changed price: truth={u1_price_truth}, lie={u1_price_lie}"

    def test_attack_underbid_below_cutoff(self):
        """Attack: Underbid to below the cutoff — should lose the seat."""
        bids_truth = [
            BidInput("a", "u1", 500.0, 1.0),
            BidInput("b", "u2", 300.0, 1.0),
            BidInput("c", "u3", 200.0, 1.0),
        ]
        # u1 underbids below u3's weighted value
        bids_lie = [
            BidInput("a", "u1", 150.0, 1.0),  # below 200 cutoff
            BidInput("b", "u2", 300.0, 1.0),
            BidInput("c", "u3", 200.0, 1.0),
        ]
        inp_lie = AllocationInput(bids=bids_lie, total_seats=2)
        out_lie = engine.allocate(inp_lie)

        # u1 should NOT win (u2=300, u3=200 win over u1=150)
        winner_ids = {w.user_id for w in out_lie.winners}
        assert "u1" not in winner_ids, "u1 should lose when underbidding below cutoff"

    def test_attack_collusion_bid_splitting(self):
        """Attack: Split one bid into two colluding accounts.
        User has value=1000. Split into two bids of 500 each.
        In VCG, this should not help (and may hurt)."""
        # Honest: single bid
        bids_honest = [
            BidInput("a", "u1", 1000.0, 1.0),
            BidInput("b", "u2", 600.0, 1.0),
            BidInput("c", "u3", 500.0, 1.0),
            BidInput("d", "u4", 400.0, 1.0),
        ]
        inp_honest = AllocationInput(bids=bids_honest, total_seats=2)
        out_honest = engine.allocate(inp_honest)

        u1_honest = next(
            (1000.0 - w.final_price for w in out_honest.winners if w.user_id == "u1"),
            0.0
        )

        # Colluding: split into sybil1 (500) + sybil2 (500)
        bids_collude = [
            BidInput("s1", "sybil1", 500.0, 1.0),
            BidInput("s2", "sybil2", 500.0, 1.0),
            BidInput("b", "u2", 600.0, 1.0),
            BidInput("c", "u3", 500.0, 1.0),
            BidInput("d", "u4", 400.0, 1.0),
        ]
        inp_collude = AllocationInput(bids=bids_collude, total_seats=2)
        out_collude = engine.allocate(inp_collude)

        sybil_total_utility = 0.0
        for w in out_collude.winners:
            if w.user_id in ("sybil1", "sybil2"):
                # Real value is proportional, but total surplus to colluder
                sybil_total_utility += (500.0 - w.final_price)

        # Collusion should not increase total utility vs honest single bid
        # (It may even decrease because the colluder might not win both seats)
        assert u1_honest >= sybil_total_utility - 1e-9, \
            f"BROKEN! Collusion profitable: honest={u1_honest:.2f}, collude={sybil_total_utility:.2f}"

    def test_attack_sybil_with_tiny_bids(self):
        """Attack: Create 100 sybil accounts with tiny bids to flood.
        Should not affect honest bidders' outcomes."""
        real_bids = [
            BidInput(f"r{i}", f"real{i}", 100.0 + i * 10, 1.0)
            for i in range(10)
        ]
        sybil_bids = [
            BidInput(f"s{i}", f"sybil{i}", 0.01, 1.0)
            for i in range(100)
        ]

        inp_real = AllocationInput(bids=real_bids, total_seats=5)
        inp_with_sybil = AllocationInput(bids=real_bids + sybil_bids, total_seats=5)

        out_real = engine.allocate(inp_real)
        out_sybil = engine.allocate(inp_with_sybil)

        # Same winners
        real_winners = {w.user_id for w in out_real.winners}
        sybil_winners = {w.user_id for w in out_sybil.winners}
        real_in_sybil = sybil_winners & {f"real{i}" for i in range(10)}

        assert real_winners == real_in_sybil, \
            f"Sybil flood changed winners: {real_winners} vs {real_in_sybil}"

    def test_attack_random_lying_10000_scenarios(self):
        """Massive random strategy-proofness test with diverse weights.
        10,000 scenarios. Any single violation = system broken."""
        rng = random.Random(42)
        violations = []

        for trial in range(10000):
            n_bidders = rng.randint(3, 15)
            n_seats = rng.randint(1, n_bidders - 1)
            liar_idx = rng.randint(0, n_bidders - 1)

            true_values = [rng.uniform(10, 1000) for _ in range(n_bidders)]
            weights = [rng.uniform(0.57, 1.93) for _ in range(n_bidders)]

            # Truthful
            bids_truth = [
                BidInput(f"b{i}", f"u{i}", true_values[i], weights[i])
                for i in range(n_bidders)
            ]
            out_truth = engine.allocate(AllocationInput(bids=bids_truth, total_seats=n_seats))

            # Liar deviates
            lie_value = rng.uniform(0.01, 5000)
            bids_lie = [
                BidInput(f"b{i}", f"u{i}",
                         lie_value if i == liar_idx else true_values[i],
                         weights[i])
                for i in range(n_bidders)
            ]
            out_lie = engine.allocate(AllocationInput(bids=bids_lie, total_seats=n_seats))

            # Compute liar's TRUE utility
            liar_id = f"u{liar_idx}"
            true_val = true_values[liar_idx]

            util_truth = 0.0
            for w in out_truth.winners:
                if w.user_id == liar_id:
                    util_truth = true_val - w.final_price

            util_lie = 0.0
            for w in out_lie.winners:
                if w.user_id == liar_id:
                    util_lie = true_val - w.final_price

            if util_lie > util_truth + 1e-6:
                violations.append({
                    "trial": trial,
                    "true_val": true_val,
                    "lie_val": lie_value,
                    "weight": weights[liar_idx],
                    "util_truth": util_truth,
                    "util_lie": util_lie,
                    "gain": util_lie - util_truth,
                })

        assert len(violations) == 0, \
            f"BROKEN! {len(violations)} strategy-proofness violations!\n" \
            f"First: {violations[0]}"


# ============================================================
# Attack 2: Individual Rationality Breaking Attempts
# ============================================================

class TestAttackIndividualRationality:
    """Try to make someone pay more than their bid."""

    def test_attack_ir_extreme_weight_ratio(self):
        """Attack: Extreme weight disparity — w_min bidder vs w_max.
        Can m_i exceed b_i when weights are extreme?"""
        bids = [
            BidInput("a", "u1", 100.0, 0.57),   # low weight
            BidInput("b", "u2", 100.0, 1.93),   # high weight
            BidInput("c", "u3", 90.0, 1.0),     # loser
        ]
        inp = AllocationInput(bids=bids, total_seats=2)
        out = engine.allocate(inp)

        for w in out.winners:
            assert w.final_price <= w.bid_amount + 1e-9, \
                f"IR BROKEN! {w.user_id} pays {w.final_price} > bid {w.bid_amount}"

    def test_attack_ir_weight_near_zero(self):
        """Attack: Very small weight — payment = externality / w_i → huge?"""
        bids = [
            BidInput("a", "u1", 1000.0, 0.001),   # near-zero weight
            BidInput("b", "u2", 500.0, 1.0),
            BidInput("c", "u3", 400.0, 1.0),      # loser
        ]
        inp = AllocationInput(bids=bids, total_seats=2)
        out = engine.allocate(inp)

        for w in out.winners:
            assert w.final_price <= w.bid_amount + 1e-9, \
                f"IR BROKEN! {w.user_id} pays {w.final_price:.2f} > bid {w.bid_amount:.2f}"

    def test_attack_ir_random_10000(self):
        """10,000 random scenarios checking IR property."""
        rng = random.Random(123)
        violations = []

        for trial in range(10000):
            n = rng.randint(3, 20)
            k = rng.randint(1, n - 1)
            bids = [
                BidInput(f"b{i}", f"u{i}",
                         rng.uniform(1, 10000),
                         rng.uniform(0.1, 5.0))
                for i in range(n)
            ]
            out = engine.allocate(AllocationInput(bids=bids, total_seats=k))
            for w in out.winners:
                if w.final_price > w.bid_amount + 1e-9:
                    violations.append({
                        "trial": trial,
                        "user": w.user_id,
                        "bid": w.bid_amount,
                        "price": w.final_price,
                        "weight": w.effective_weight,
                    })

        assert len(violations) == 0, \
            f"IR BROKEN! {len(violations)} violations!\nFirst: {violations[0]}"

    def test_attack_ir_multi_qty_extreme(self):
        """Multi-quantity with extreme weight: can total price exceed b_i × q_won?"""
        bids = [
            BidInput("a", "u1", 100.0, 0.1, quantity=5),
            BidInput("b", "u2", 80.0, 1.0, quantity=1),
            BidInput("c", "u3", 70.0, 1.0, quantity=1),
            BidInput("d", "u4", 60.0, 1.0, quantity=1),
            BidInput("e", "u5", 50.0, 1.0, quantity=1),
        ]
        inp = AllocationInput(bids=bids, total_seats=5)
        out = engine.allocate(inp)

        for w in out.winners:
            # Derive quantity_won from aggregated weighted_value
            q_won = round(w.weighted_value / (w.bid_amount * w.effective_weight)) if w.bid_amount * w.effective_weight > 0 else 1
            total_value = w.bid_amount * max(q_won, 1)
            assert w.final_price <= total_value + 1e-9, \
                f"IR BROKEN! {w.user_id} total price {w.final_price:.2f} > value {total_value:.2f} (q={q_won})"


# ============================================================
# Attack 3: Fan Weight Gaming
# ============================================================

class TestAttackFanWeightGaming:
    """Try to exploit the fan weight system."""

    def test_attack_fanclub_toggle_dominance(self):
        """Attack: Toggling fanclub (binary) should not swing weight too much.
        With ALPHA_MAX_BINARY=0.40, max swing from s3 alone."""
        scores_without = FanScores(loyalty=0.5, history=0.5, fanclub=0.0, behavior=1.0, freshness=0.0)
        scores_with = FanScores(loyalty=0.5, history=0.5, fanclub=1.0, behavior=1.0, freshness=0.0)

        # Use max binary alpha to maximize swing
        alphas = AlphaWeights(0.20, 0.20, 0.40, 0.15, 0.05)
        w_without = compute_fan_weight_v2(scores_without, alphas=alphas)
        w_with = compute_fan_weight_v2(scores_with, alphas=alphas)

        ratio = w_with / w_without
        # Binary flip should not cause more than 2x swing
        assert ratio < 2.0, \
            f"BROKEN! Fanclub toggle causes {ratio:.2f}x weight swing"

    def test_attack_all_binary_alpha_maximized(self):
        """Attack: What if organizer sets fanclub alpha to max binary?"""
        alphas = AlphaWeights(0.20, 0.20, 0.40, 0.15, 0.05)
        alphas.validate()  # Should not raise

        # Non-member
        scores_0 = FanScores(fanclub=0.0)
        w0 = compute_fan_weight_v2(scores_0, alphas=alphas)

        # Member
        scores_1 = FanScores(fanclub=1.0)
        w1 = compute_fan_weight_v2(scores_1, alphas=alphas)

        # VCG price ratio = w1/w0 (higher weight pays LESS)
        price_ratio = w1 / w0  # fanclub member's discount
        # Fanclub member gets up to price_ratio discount
        # Check this is bounded
        assert price_ratio < 3.0, \
            f"BROKEN! Fanclub gives {price_ratio:.2f}x VCG price advantage"

    def test_attack_score_out_of_bounds(self):
        """Attack: What if scores are outside [0,1]?
        System should handle gracefully or reject."""
        # Negative scores
        scores = FanScores(loyalty=-1.0, history=-1.0, fanclub=-1.0, behavior=-1.0, freshness=-1.0)
        w = compute_fan_weight_v2(scores)
        assert w >= 0.5, f"Weight below 0.5 with negative scores: {w}"

        # Scores > 1
        scores = FanScores(loyalty=10.0, history=10.0, fanclub=10.0, behavior=10.0, freshness=10.0)
        w = compute_fan_weight_v2(scores)
        assert w <= 2.0, f"Weight above 2.0 with inflated scores: {w}"

    def test_attack_sigmoid_saturation_exploit(self):
        """Attack: Is there a "cliff" in sigmoid where small changes cause big swings?
        Maximum gradient of sigmoid is at x=0. Check that dw/ds is bounded."""
        # Compute numerical gradient around the steepest point (Raw=0.5=mu)
        eps = 0.001
        scores_lo = FanScores(loyalty=0.5 - eps, history=0.5, fanclub=0.0, behavior=1.0, freshness=0.0)
        scores_hi = FanScores(loyalty=0.5 + eps, history=0.5, fanclub=0.0, behavior=1.0, freshness=0.0)

        w_lo = compute_fan_weight_v2(scores_lo)
        w_hi = compute_fan_weight_v2(scores_hi)

        # Gradient per unit score change (accounting for alpha=0.30 on loyalty)
        dw_ds = (w_hi - w_lo) / (2 * eps * 0.30)

        # Maximum gradient should be bounded (κ × W_SCALE / 4 = 6 × 1.5 / 4 = 2.25)
        assert dw_ds < 3.0, f"Gradient too steep: {dw_ds:.4f}"

    def test_attack_history_decay_gaming(self):
        """Attack: Can someone game the decay by claiming recent attendance?
        Verify decay function is monotonically decreasing."""
        scores = []
        for days_ago in range(0, 3650, 30):  # 0 to 10 years
            score = compute_history_score([(days_ago, 10)], max_count=50)
            scores.append(score)

        for i in range(1, len(scores)):
            assert scores[i] <= scores[i-1] + 1e-9, \
                f"BROKEN! History score increases over time: day {(i-1)*30}={scores[i-1]:.4f} < day {i*30}={scores[i]:.4f}"

    def test_attack_behavior_score_manipulation(self):
        """Attack: User with high no-show creates new account → behavior=1.0.
        This is a sybil attack through behavior dimension."""
        bad_behavior = compute_behavior_score(no_show_rate=0.5, cancel_rate=0.3)
        new_account = compute_behavior_score()  # perfect default

        scores_bad = FanScores(behavior=bad_behavior, loyalty=0.8, history=0.7)
        scores_new = FanScores(behavior=new_account, loyalty=0.0, history=0.0, freshness=1.0)

        w_bad = compute_fan_weight_v2(scores_bad)
        w_new = compute_fan_weight_v2(scores_new)

        # New sybil account should NOT get a higher weight than the real fan
        # with bad behavior (because loyalty+history compensate)
        # This is a DESIGN question — we just verify the values are reasonable
        # The sybil has no loyalty/history so should be lower
        assert w_new < w_bad + 0.3, \
            f"Sybil gaming: new account w={w_new:.4f} vs bad-behavior veteran w={w_bad:.4f}"


# ============================================================
# Attack 4: Multi-Pool Cross-Strategy
# ============================================================

class TestAttackMultiPool:
    """Try to exploit multi-pool allocation."""

    def test_attack_pool_seat_overflow(self):
        """Attack: Do pool seats ever exceed total?"""
        for total in range(1, 200):
            seats = compute_pool_seats(total)
            actual_total = sum(seats.values())
            assert actual_total == total, \
                f"BROKEN! Pool seats {actual_total} != total {total}"

    def test_attack_pool_seats_negative(self):
        """Attack: Can pool A get negative seats?"""
        for total in range(1, 200):
            seats = compute_pool_seats(total)
            for pool, count in seats.items():
                assert count >= 0, f"BROKEN! Pool {pool} has {count} seats (total={total})"

    def test_attack_zero_seats_event(self):
        """Attack: 0 total seats."""
        seats = compute_pool_seats(0)
        assert sum(seats.values()) == 0

    def test_attack_abuse_score_boundary(self):
        """Attack: abuse_score exactly at threshold."""
        user = UserEligibility("u1", VerificationLevel.REAL_NAME, abuse_score=ABUSE_THRESHOLD)
        result = check_eligibility(user)
        assert not result.is_blocked, "User at exactly threshold should NOT be blocked"

        user2 = UserEligibility("u2", VerificationLevel.REAL_NAME, abuse_score=ABUSE_THRESHOLD + 0.0001)
        result2 = check_eligibility(user2)
        assert result2.is_blocked, "User above threshold should be blocked"

    def test_attack_negative_abuse_score(self):
        """Attack: Negative abuse score — should still work."""
        user = UserEligibility("u1", VerificationLevel.PHONE, abuse_score=-1.0)
        result = check_eligibility(user)
        assert not result.is_blocked

    def test_attack_pool_c_always_accessible(self):
        """Verify: Even unverified users ALWAYS get Pool C."""
        for level in VerificationLevel:
            user = UserEligibility("u1", level, abuse_score=0.0)
            result = check_eligibility(user)
            assert Pool.C in result.eligible_pools, \
                f"BROKEN! Level {level} doesn't get Pool C"

    def test_attack_blocked_user_no_pools(self):
        """Blocked users must get ZERO pools — no exceptions."""
        for level in VerificationLevel:
            user = UserEligibility("u1", level, is_fanclub_member=True,
                                   is_new_user=True, abuse_score=0.9)
            result = check_eligibility(user)
            assert result.is_blocked
            assert len(result.eligible_pools) == 0, \
                f"BROKEN! Blocked user still has pools: {result.eligible_pools}"


# ============================================================
# Attack 5: Numerical Instability
# ============================================================

class TestAttackNumericalInstability:
    """Try to crash the system with extreme values."""

    def test_attack_zero_weight(self):
        """Attack: w_i = 0 → input validation rejects zero weight."""
        bids = [
            BidInput("a", "u1", 100.0, 0.0),   # zero weight!
            BidInput("b", "u2", 200.0, 1.0),
            BidInput("c", "u3", 150.0, 1.0),
        ]
        inp = AllocationInput(bids=bids, total_seats=2)
        with pytest.raises(ValueError, match="positive"):
            engine.allocate(inp)

    def test_attack_zero_bid(self):
        """Attack: b_i = 0."""
        bids = [
            BidInput("a", "u1", 0.0, 1.0),
            BidInput("b", "u2", 100.0, 1.0),
            BidInput("c", "u3", 50.0, 1.0),
        ]
        inp = AllocationInput(bids=bids, total_seats=2)
        out = engine.allocate(inp)
        assert out is not None

    def test_attack_identical_weighted_values(self):
        """Attack: All bidders have identical w*b — tiebreaking."""
        bids = [
            BidInput("a", "u1", 100.0, 1.0),
            BidInput("b", "u2", 50.0, 2.0),   # 50×2=100
            BidInput("c", "u3", 200.0, 0.5),  # 200×0.5=100
            BidInput("d", "u4", 100.0, 1.0),  # 100×1=100
        ]
        inp = AllocationInput(bids=bids, total_seats=2)
        out = engine.allocate(inp)

        # All have wv=100. Tiebreaking is by sort order.
        # Should not crash.
        assert len(out.winners) <= 2
        # All winners should pay 0 if the excluded also has wv=100
        # Actually: first excluded wv = 100, so m_i = 100/w_i
        for w in out.winners:
            assert w.final_price <= w.bid_amount + 1e-9

    def test_attack_very_large_bids(self):
        """Attack: Bids near float max."""
        bids = [
            BidInput("a", "u1", 1e15, 1.0),
            BidInput("b", "u2", 1e15 - 1, 1.0),
            BidInput("c", "u3", 1e14, 1.0),
        ]
        inp = AllocationInput(bids=bids, total_seats=2)
        out = engine.allocate(inp)
        assert out is not None
        for w in out.winners:
            assert not math.isnan(w.final_price)
            assert not math.isinf(w.final_price)

    def test_attack_very_small_positive_bids(self):
        """Attack: Bids near machine epsilon."""
        bids = [
            BidInput("a", "u1", 1e-15, 1.0),
            BidInput("b", "u2", 1e-15, 1.0),
            BidInput("c", "u3", 1e-16, 1.0),
        ]
        inp = AllocationInput(bids=bids, total_seats=2)
        out = engine.allocate(inp)
        assert out is not None
        for w in out.winners:
            assert not math.isnan(w.final_price)

    def test_attack_single_bidder(self):
        """Attack: Only 1 bidder for 1 seat — no competition."""
        bids = [BidInput("a", "u1", 1000.0, 1.5)]
        inp = AllocationInput(bids=bids, total_seats=1)
        out = engine.allocate(inp)

        assert len(out.winners) == 1
        # VCG with no competition → price = 0
        assert out.winners[0].final_price == 0.0

    def test_attack_seats_equal_bidders(self):
        """Attack: K = N (everyone wins) → price = 0."""
        bids = [
            BidInput(f"b{i}", f"u{i}", 100.0 + i, 1.0)
            for i in range(10)
        ]
        inp = AllocationInput(bids=bids, total_seats=10)
        out = engine.allocate(inp)

        assert len(out.winners) == 10
        for w in out.winners:
            assert w.final_price == 0.0, \
                f"Everyone wins but {w.user_id} pays {w.final_price}"

    def test_attack_negative_bids(self):
        """Attack: Negative bid amounts — input validation rejects them."""
        bids = [
            BidInput("a", "u1", -100.0, 1.0),
            BidInput("b", "u2", 200.0, 1.0),
            BidInput("c", "u3", 150.0, 1.0),
        ]
        inp = AllocationInput(bids=bids, total_seats=2)
        with pytest.raises(ValueError, match="non-negative"):
            engine.allocate(inp)

    def test_attack_sigmoid_extreme_inputs(self):
        """Attack: Extreme inputs to sigmoid."""
        assert sigmoid(1000) == 1.0
        assert sigmoid(-1000) == 0.0
        assert sigmoid(0) == 0.5
        assert not math.isnan(sigmoid(float('inf')))
        assert not math.isnan(sigmoid(float('-inf')))

    def test_attack_nan_propagation(self):
        """Attack: NaN in fan scores — validation rejects NaN."""
        scores = FanScores(loyalty=float('nan'))
        with pytest.raises(ValueError, match="finite"):
            compute_fan_weight_v2(scores)


# ============================================================
# Attack 6: Multi-Quantity Edge Cases
# ============================================================

class TestAttackMultiQuantity:
    """Try to break multi-quantity VCG."""

    def test_attack_monopolist_buys_all_seats(self):
        """Attack: One bidder requests ALL seats."""
        bids = [
            BidInput("a", "u1", 1000.0, 1.0, quantity=10),
            BidInput("b", "u2", 500.0, 1.0, quantity=1),
            BidInput("c", "u3", 400.0, 1.0, quantity=1),
        ]
        inp = AllocationInput(bids=bids, total_seats=10)
        out = engine.allocate(inp)

        # u1 should win all 10 (wv=1000 per unit, highest)
        u1_winner = next((w for w in out.winners if w.user_id == "u1"), None)
        assert u1_winner is not None

        # IR check
        assert u1_winner.final_price <= u1_winner.bid_amount + 1e-9

    def test_attack_quantity_exceeds_seats(self):
        """Attack: Bid for more than total seats."""
        bids = [
            BidInput("a", "u1", 100.0, 1.0, quantity=100),  # wants 100
            BidInput("b", "u2", 50.0, 1.0, quantity=1),
        ]
        inp = AllocationInput(bids=bids, total_seats=5)
        out = engine.allocate(inp)
        # Should not crash, u1 gets at most 5
        assert out is not None

    def test_attack_multi_qty_vs_single_qty_fairness(self):
        """Attack: Is multi-qty bidder treated fairly vs multiple single-qty bidders?
        Compare: u1 bids q=3 at b=100 vs u1a/u1b/u1c each bid q=1 at b=100."""
        # Scenario 1: Single multi-qty bidder
        bids_multi = [
            BidInput("a", "u1", 100.0, 1.0, quantity=3),
            BidInput("b", "u2", 80.0, 1.0, quantity=1),
            BidInput("c", "u3", 70.0, 1.0, quantity=1),
            BidInput("d", "u4", 60.0, 1.0, quantity=1),
            BidInput("e", "u5", 50.0, 1.0, quantity=1),
        ]
        out_multi = engine.allocate(AllocationInput(bids=bids_multi, total_seats=3))

        # Scenario 2: Three separate single-qty bidders (NOT sybil — different real users)
        bids_single = [
            BidInput("a1", "u1a", 100.0, 1.0, quantity=1),
            BidInput("a2", "u1b", 100.0, 1.0, quantity=1),
            BidInput("a3", "u1c", 100.0, 1.0, quantity=1),
            BidInput("b", "u2", 80.0, 1.0, quantity=1),
            BidInput("c", "u3", 70.0, 1.0, quantity=1),
            BidInput("d", "u4", 60.0, 1.0, quantity=1),
            BidInput("e", "u5", 50.0, 1.0, quantity=1),
        ]
        out_single = engine.allocate(AllocationInput(bids=bids_single, total_seats=3))

        # Multi-qty should pay LESS total than 3 separate bidders combined
        # Because true VCG removes all units at once (single counterfactual)
        u1_multi_price = sum(w.final_price for w in out_multi.winners if w.user_id == "u1")
        u1_single_total = sum(w.final_price for w in out_single.winners
                              if w.user_id in ("u1a", "u1b", "u1c"))

        # True VCG for multi-qty should be <= virtual expansion price
        assert u1_multi_price <= u1_single_total + 1e-9, \
            f"Multi-qty bidder overcharged: multi={u1_multi_price:.2f}, " \
            f"separate={u1_single_total:.2f}"

    def test_attack_multi_qty_ir_random(self):
        """1000 random multi-quantity scenarios checking IR.
        IR for multi-qty: total_payment ≤ b_i × q_won."""
        rng = random.Random(777)
        violations = []

        for trial in range(1000):
            n = rng.randint(3, 10)
            k = rng.randint(2, 10)
            bids = [
                BidInput(f"b{i}", f"u{i}",
                         rng.uniform(10, 500),
                         rng.uniform(0.5, 2.0),
                         quantity=rng.randint(1, 3))
                for i in range(n)
            ]
            out = engine.allocate(AllocationInput(bids=bids, total_seats=k))
            for w in out.winners:
                # Derive quantity won from aggregated weighted_value
                per_unit_wv = w.bid_amount * w.effective_weight
                q_won = round(w.weighted_value / per_unit_wv) if per_unit_wv > 0 else 1
                q_won = max(q_won, 1)
                total_max_payment = w.bid_amount * q_won
                if w.final_price > total_max_payment + 1e-9:
                    violations.append({
                        "trial": trial,
                        "user": w.user_id,
                        "bid": w.bid_amount,
                        "price": w.final_price,
                        "q_won": q_won,
                        "max_payment": total_max_payment,
                        "weight": w.effective_weight,
                    })

        assert len(violations) == 0, \
            f"IR BROKEN! {len(violations)} multi-qty violations!\nFirst: {violations[0]}"

    def test_attack_multi_qty_strategy_proof_random(self):
        """1000 random multi-quantity strategy-proofness tests.
        Utility = true_value × q_won - total_payment."""
        rng = random.Random(888)
        violations = []

        def compute_utility(output, user_id, true_val):
            """Compute true utility for a multi-qty bidder."""
            for w in output.winners:
                if w.user_id == user_id:
                    per_unit_wv = w.bid_amount * w.effective_weight
                    q_won = round(w.weighted_value / per_unit_wv) if per_unit_wv > 0 else 1
                    q_won = max(q_won, 1)
                    return true_val * q_won - w.final_price
            return 0.0  # didn't win

        for trial in range(1000):
            n = rng.randint(3, 8)
            k = rng.randint(2, 8)
            liar = rng.randint(0, n - 1)

            true_vals = [rng.uniform(10, 500) for _ in range(n)]
            weights = [rng.uniform(0.5, 2.0) for _ in range(n)]
            quantities = [rng.randint(1, 3) for _ in range(n)]

            bids_truth = [
                BidInput(f"b{i}", f"u{i}", true_vals[i], weights[i], quantities[i])
                for i in range(n)
            ]
            out_truth = engine.allocate(AllocationInput(bids=bids_truth, total_seats=k))

            lie_val = rng.uniform(0.01, 2000)
            bids_lie = list(bids_truth)
            bids_lie[liar] = BidInput(f"b{liar}", f"u{liar}",
                                      lie_val, weights[liar], quantities[liar])
            out_lie = engine.allocate(AllocationInput(bids=bids_lie, total_seats=k))

            liar_id = f"u{liar}"
            true_val = true_vals[liar]

            util_truth = compute_utility(out_truth, liar_id, true_val)
            util_lie = compute_utility(out_lie, liar_id, true_val)

            if util_lie > util_truth + 1e-6:
                violations.append({
                    "trial": trial,
                    "true_val": true_val,
                    "lie_val": lie_val,
                    "weight": weights[liar],
                    "qty": quantities[liar],
                    "util_truth": util_truth,
                    "util_lie": util_lie,
                })

        assert len(violations) == 0, \
            f"SP BROKEN (multi-qty)! {len(violations)} violations!\nFirst: {violations[0]}"


# ============================================================
# Attack 7: Weight System — VCG Interaction Exploits
# ============================================================

class TestAttackWeightVCGInteraction:
    """Attacks on the interaction between fan weight and VCG pricing."""

    def test_attack_weight_creates_revenue_negative(self):
        """Attack: Can weighted VCG produce negative revenue?"""
        bids = [
            BidInput("a", "u1", 100.0, 1.93),
            BidInput("b", "u2", 100.0, 0.57),
            BidInput("c", "u3", 50.0, 1.0),
        ]
        inp = AllocationInput(bids=bids, total_seats=2)
        out = engine.allocate(inp)

        total_revenue = sum(w.final_price for w in out.winners)
        assert total_revenue >= 0, f"Negative revenue: {total_revenue}"

    def test_attack_weight_ordering_paradox(self):
        """Attack: Can a lower-bid, higher-weight user win over higher-bid, lower-weight?
        This is BY DESIGN (wv-based), but verify price is still IR."""
        bids = [
            BidInput("a", "u1", 50.0, 1.93),   # wv = 96.5
            BidInput("b", "u2", 90.0, 1.0),     # wv = 90
            BidInput("c", "u3", 80.0, 1.0),     # wv = 80
        ]
        inp = AllocationInput(bids=bids, total_seats=2)
        out = engine.allocate(inp)

        winners = {w.user_id for w in out.winners}
        # u1 (wv=96.5) should beat u3 (wv=80)
        assert "u1" in winners, "Weighted allocation should favor u1"
        assert "u2" in winners, "u2 should also win"

        for w in out.winners:
            assert w.final_price <= w.bid_amount + 1e-9

    def test_attack_price_discrimination_bounds(self):
        """Attack: Maximum price spread between min-weight and max-weight winners."""
        bids = [
            BidInput("a", "u1", 1000.0, 0.57),   # min weight
            BidInput("b", "u2", 1000.0, 1.93),   # max weight
            BidInput("c", "u3", 500.0, 1.0),      # loser (cutoff)
        ]
        inp = AllocationInput(bids=bids, total_seats=2)
        out = engine.allocate(inp)

        prices = {w.user_id: w.final_price for w in out.winners}

        if "u1" in prices and "u2" in prices:
            ratio = prices["u1"] / prices["u2"] if prices["u2"] > 0 else float("inf")
            # Max theoretical ratio = w_max/w_min = 1.93/0.57 ≈ 3.39
            assert ratio < 3.5, f"Price ratio {ratio:.2f} exceeds theoretical max"
            assert ratio > 3.0, f"Price ratio {ratio:.2f} below expected 3.39"

    def test_attack_min_price_floor_interaction(self):
        """min_price acts as reserve price: bids below it are excluded.
        Remaining winners all have bid ≥ min_price, so IR holds."""
        bids = [
            BidInput("a", "u1", 100.0, 1.93),
            BidInput("b", "u2", 100.0, 1.0),
            BidInput("c", "u3", 10.0, 1.0),   # bid < min_price → excluded
        ]
        # Set min_price=50. u3 (bid=10) is pre-filtered out.
        inp = AllocationInput(bids=bids, total_seats=2, min_price=50.0)
        out = engine.allocate(inp)

        # u3 should be excluded (bid=10 < min_price=50)
        winner_ids = {w.user_id for w in out.winners}
        assert "u3" not in winner_ids, "u3 should be excluded (bid < min_price)"

        for w in out.winners:
            assert w.final_price <= w.bid_amount + 1e-9, \
                f"IR broken: {w.user_id} pays {w.final_price} > bid {w.bid_amount}"

    def test_attack_min_price_excludes_low_bidders(self):
        """min_price > bid → bidder is pre-filtered (not allocated).
        Reserve price is a participation constraint, not payment modifier."""
        bids = [
            BidInput("a", "u1", 30.0, 1.93),   # wv=57.9 but bid=30 < min_price=50
            BidInput("b", "u2", 100.0, 1.0),   # wv=100, bid≥50 → participates
            BidInput("c", "u3", 20.0, 1.0),    # wv=20, bid=20 < 50 → excluded
        ]
        # min_price = 50: u1(30) and u3(20) both excluded
        inp = AllocationInput(bids=bids, total_seats=2, min_price=50.0)
        out = engine.allocate(inp)

        winner_ids = {w.user_id for w in out.winners}
        assert "u1" not in winner_ids, "u1 (bid=30) should be excluded by reserve price"
        assert "u3" not in winner_ids, "u3 (bid=20) should be excluded by reserve price"
        assert "u2" in winner_ids, "u2 (bid=100) should win"

        for w in out.winners:
            assert w.final_price <= w.bid_amount + 1e-9

    def test_attack_stabilization_breaks_ir(self):
        """Attack: Can price stabilization push price above bid?"""
        bids = [
            BidInput("a", "u1", 100.0, 0.5),
            BidInput("b", "u2", 100.0, 2.0),
            BidInput("c", "u3", 90.0, 1.0),
        ]
        inp = AllocationInput(bids=bids, total_seats=2, stabilization_lambda=0.5)
        out = engine.allocate(inp)

        for w in out.winners:
            assert w.final_price <= w.bid_amount + 1e-9, \
                f"Stabilization broke IR: {w.user_id} pays {w.final_price} > {w.bid_amount}"


# ============================================================
# Attack 8: Alpha Template Exploits
# ============================================================

class TestAttackAlphaTemplates:
    """Try to exploit alpha weight configurations."""

    def test_attack_all_templates_sum_to_one(self):
        """Verify all event templates sum exactly to 1.0."""
        for event_type, alphas in EVENT_TEMPLATES.items():
            total = sum(alphas.to_list())
            assert abs(total - 1.0) < 1e-9, \
                f"Template {event_type} sum = {total}"

    def test_attack_all_templates_within_bounds(self):
        """Verify all templates respect alpha bounds."""
        for event_type, alphas in EVENT_TEMPLATES.items():
            try:
                alphas.validate()
            except ValueError as e:
                pytest.fail(f"Template {event_type} invalid: {e}")

    def test_attack_custom_alpha_boundary(self):
        """Attack: Try to create alpha at exact boundary."""
        # Continuous dim at exactly ALPHA_MAX
        a = AlphaWeights(ALPHA_MAX, ALPHA_MIN, ALPHA_MIN, ALPHA_MIN, 1.0 - ALPHA_MAX - 3 * ALPHA_MIN)
        a.validate()  # Should not raise

    def test_attack_custom_alpha_binary_boundary(self):
        """Attack: Fanclub at exactly ALPHA_MAX_BINARY."""
        a = AlphaWeights(0.25, 0.15, ALPHA_MAX_BINARY, 0.10, 1.0 - 0.25 - 0.15 - ALPHA_MAX_BINARY - 0.10)
        a.validate()  # Should not raise

    def test_attack_alpha_just_above_max(self):
        """Attack: Alpha barely above max — should be caught."""
        with pytest.raises(ValueError):
            a = AlphaWeights(ALPHA_MAX + 0.01, 0.15, 0.15, 0.15, 1.0 - ALPHA_MAX - 0.01 - 0.45)
            a.validate()

    def test_attack_alpha_binary_just_above_max(self):
        """Attack: Fanclub alpha barely above binary max."""
        with pytest.raises(ValueError):
            a = AlphaWeights(0.20, 0.15, ALPHA_MAX_BINARY + 0.01, 0.15,
                             1.0 - 0.50 - ALPHA_MAX_BINARY - 0.01)
            a.validate()


# ============================================================
# Attack 9: Decay Function Precision
# ============================================================

class TestAttackDecayPrecision:
    """Verify decay function mathematical properties."""

    def test_attack_exact_halflife(self):
        """2-year half-life must be EXACT at t=730."""
        decay = math.exp(-DECAY_LAMBDA * 730)
        assert abs(decay - 0.5) < 1e-10, \
            f"Half-life broken: decay(730) = {decay}, expected 0.5"

    def test_attack_double_halflife(self):
        """At t=1460 (4 years), decay should be exactly 0.25."""
        decay = math.exp(-DECAY_LAMBDA * 1460)
        assert abs(decay - 0.25) < 1e-10, \
            f"Double half-life broken: decay(1460) = {decay}, expected 0.25"

    def test_attack_zero_days(self):
        """At t=0, decay should be exactly 1.0."""
        decay = math.exp(-DECAY_LAMBDA * 0)
        assert abs(decay - 1.0) < 1e-15

    def test_attack_decay_monotonic(self):
        """Decay must be strictly monotonically decreasing."""
        prev = 1.0
        for t in range(1, 10000):
            d = math.exp(-DECAY_LAMBDA * t)
            assert d < prev, f"Non-monotonic at t={t}: {d} >= {prev}"
            prev = d

    def test_attack_decay_never_negative(self):
        """Decay should never be negative or zero (exponential)."""
        for t in [0, 1, 100, 1000, 10000, 100000]:
            d = math.exp(-DECAY_LAMBDA * t)
            assert d > 0, f"Decay non-positive at t={t}: {d}"


# ============================================================
# Attack 10: Batch Window State Machine
# ============================================================

class TestAttackBatchWindow:
    """Try to break batch window state machine."""

    def test_attack_invalid_transitions(self):
        """Try every invalid state transition."""
        from talkfile_engine.batch_window import (
            create_window, transition_phase, AuctionPhase,
            VALID_TRANSITIONS, BatchWindowConfig,
        )
        from datetime import datetime, timezone

        window = create_window("ev1", datetime.now(timezone.utc))
        all_phases = list(AuctionPhase)

        for start_phase in all_phases:
            valid_next = VALID_TRANSITIONS.get(start_phase, [])
            for target_phase in all_phases:
                if target_phase in valid_next:
                    continue  # Valid transition, skip
                # Invalid transition — must raise
                window.phase = start_phase
                with pytest.raises(ValueError):
                    transition_phase(window, target_phase)

    def test_attack_window_hours_bounds(self):
        """Try creating windows outside allowed duration."""
        from talkfile_engine.batch_window import BatchWindowConfig

        with pytest.raises(ValueError):
            BatchWindowConfig(window_hours=23).validate()  # Below 24

        with pytest.raises(ValueError):
            BatchWindowConfig(window_hours=73).validate()  # Above 72

        # Boundary values should work
        BatchWindowConfig(window_hours=24).validate()
        BatchWindowConfig(window_hours=72).validate()

    def test_attack_negative_min_price(self):
        """Try negative min_price in window config."""
        from talkfile_engine.batch_window import BatchWindowConfig

        with pytest.raises(ValueError):
            BatchWindowConfig(min_price=-1.0).validate()

    def test_attack_max_less_than_min(self):
        """max_price < min_price should fail."""
        from talkfile_engine.batch_window import BatchWindowConfig

        with pytest.raises(ValueError):
            BatchWindowConfig(min_price=100.0, max_price=50.0).validate()
