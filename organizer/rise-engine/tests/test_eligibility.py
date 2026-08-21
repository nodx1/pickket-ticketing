"""
Eligibility Gate Tests (Layer 1)
=================================
Tests for verification levels, pool qualification matrix,
abuse filtering, and seat allocation.
"""

import pytest
from talkfile_engine.eligibility import (
    VerificationLevel, Pool,
    UserEligibility, EligibilityResult,
    check_eligibility, compute_pool_seats, compute_abuse_score,
    DEFAULT_POOL_RATIOS, POOL_ALLOCATION_ORDER, ABUSE_THRESHOLD,
)


class TestVerificationLevels:
    """Test pool access by verification level."""

    def test_unverified_only_pool_c(self):
        """Level 0 (email only) → Pool C only."""
        user = UserEligibility(user_id="u1", verification_level=VerificationLevel.UNVERIFIED)
        result = check_eligibility(user)
        assert not result.is_blocked
        assert result.eligible_pools == [Pool.C]

    def test_phone_verified_gets_a_c(self):
        """Level 1 (phone) → Pool A, C."""
        user = UserEligibility(user_id="u1", verification_level=VerificationLevel.PHONE)
        result = check_eligibility(user)
        assert Pool.A in result.eligible_pools
        assert Pool.C in result.eligible_pools
        assert Pool.D not in result.eligible_pools

    def test_phone_verified_new_user_gets_a_b_c(self):
        """Level 1 + new user → Pool A, B, C."""
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.PHONE,
            is_new_user=True,
        )
        result = check_eligibility(user)
        assert set(result.eligible_pools) == {Pool.A, Pool.B, Pool.C}

    def test_real_name_gets_a_c(self):
        """Level 2 without fanclub → Pool A, C."""
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.REAL_NAME,
        )
        result = check_eligibility(user)
        assert Pool.A in result.eligible_pools
        assert Pool.C in result.eligible_pools
        assert Pool.D not in result.eligible_pools  # No fanclub

    def test_real_name_fanclub_gets_a_c_d(self):
        """Level 2 + fanclub → Pool A, C, D."""
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.REAL_NAME,
            is_fanclub_member=True,
        )
        result = check_eligibility(user)
        assert Pool.A in result.eligible_pools
        assert Pool.C in result.eligible_pools
        assert Pool.D in result.eligible_pools

    def test_foreign_alt_same_as_real_name(self):
        """Level 3 (foreign alt-ID) treated same as Level 2."""
        user_foreign = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.FOREIGN_ALT,
            is_fanclub_member=True,
        )
        user_real = UserEligibility(
            user_id="u2",
            verification_level=VerificationLevel.REAL_NAME,
            is_fanclub_member=True,
        )
        result_foreign = check_eligibility(user_foreign)
        result_real = check_eligibility(user_real)
        assert set(result_foreign.eligible_pools) == set(result_real.eligible_pools)

    def test_all_pools_for_new_fanclub_real_name(self):
        """Level 2 + new user + fanclub → Pool A, B, C, D (all pools)."""
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.REAL_NAME,
            is_new_user=True,
            is_fanclub_member=True,
        )
        result = check_eligibility(user)
        assert set(result.eligible_pools) == {Pool.A, Pool.B, Pool.C, Pool.D}


class TestPoolQualificationMatrix:
    """Verify the complete pool eligibility matrix from the plan.

    | User Type              | Pool A | Pool B | Pool C | Pool D |
    |------------------------|--------|--------|--------|--------|
    | Unverified new         |   ❌   |   ❌   |   ✅   |   ❌   |
    | Verified new           |   ✅   |   ✅   |   ✅   |   ❌   |
    | Verified existing      |   ✅   |   ❌   |   ✅   |   ❌   |
    | Real-name + fanclub    |   ✅   |   ❌   |   ✅   |   ✅   |
    | Foreign alt + fanclub  |   ✅   |   ❌   |   ✅   |   ✅   |
    """

    def test_unverified_new(self):
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.UNVERIFIED,
            is_new_user=True,
        )
        result = check_eligibility(user)
        assert Pool.A not in result.eligible_pools
        assert Pool.B not in result.eligible_pools
        assert Pool.C in result.eligible_pools
        assert Pool.D not in result.eligible_pools

    def test_verified_new(self):
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.PHONE,
            is_new_user=True,
        )
        result = check_eligibility(user)
        assert Pool.A in result.eligible_pools
        assert Pool.B in result.eligible_pools
        assert Pool.C in result.eligible_pools
        assert Pool.D not in result.eligible_pools

    def test_verified_existing(self):
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.PHONE,
            is_new_user=False,
        )
        result = check_eligibility(user)
        assert Pool.A in result.eligible_pools
        assert Pool.B not in result.eligible_pools
        assert Pool.C in result.eligible_pools
        assert Pool.D not in result.eligible_pools

    def test_real_name_fanclub(self):
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.REAL_NAME,
            is_fanclub_member=True,
        )
        result = check_eligibility(user)
        assert Pool.A in result.eligible_pools
        assert Pool.B not in result.eligible_pools
        assert Pool.C in result.eligible_pools
        assert Pool.D in result.eligible_pools

    def test_foreign_alt_fanclub(self):
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.FOREIGN_ALT,
            is_fanclub_member=True,
        )
        result = check_eligibility(user)
        assert Pool.A in result.eligible_pools
        assert Pool.B not in result.eligible_pools
        assert Pool.C in result.eligible_pools
        assert Pool.D in result.eligible_pools


class TestAbuseFilter:
    """Test rule-based abuse detection."""

    def test_clean_user_passes(self):
        user = UserEligibility(user_id="u1", verification_level=VerificationLevel.PHONE)
        result = check_eligibility(user)
        assert not result.is_blocked

    def test_abuse_above_threshold_blocked(self):
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.PHONE,
            abuse_score=0.8,
        )
        result = check_eligibility(user)
        assert result.is_blocked
        assert result.eligible_pools == []
        assert "appeal" in result.block_reason.lower() or "Appeal" in result.block_reason

    def test_abuse_at_threshold_passes(self):
        """Exact threshold should pass (> not >=)."""
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.PHONE,
            abuse_score=ABUSE_THRESHOLD,
        )
        result = check_eligibility(user)
        assert not result.is_blocked

    def test_abuse_just_above_threshold_blocked(self):
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.PHONE,
            abuse_score=ABUSE_THRESHOLD + 0.01,
        )
        result = check_eligibility(user)
        assert result.is_blocked

    def test_blocked_user_gets_no_pools(self):
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.REAL_NAME,
            is_fanclub_member=True,
            abuse_score=0.9,
        )
        result = check_eligibility(user)
        assert result.is_blocked
        assert len(result.eligible_pools) == 0


class TestAbuseScoreComputation:
    """Test rule-based abuse score computation."""

    def test_clean_score(self):
        assert compute_abuse_score() == 0.0

    def test_multi_account_3_plus(self):
        score = compute_abuse_score(multi_account_same_ip=3)
        assert score == 0.3

    def test_multi_account_2(self):
        score = compute_abuse_score(multi_account_same_ip=2)
        assert score == 0.1

    def test_multi_account_1(self):
        score = compute_abuse_score(multi_account_same_ip=1)
        assert score == 0.0

    def test_rapid_cancel_5_plus(self):
        score = compute_abuse_score(rapid_cancel_count=5)
        assert score == 0.3

    def test_rapid_cancel_3(self):
        score = compute_abuse_score(rapid_cancel_count=3)
        assert score == 0.15

    def test_bot_detected(self):
        score = compute_abuse_score(bot_signature_detected=True)
        assert score == 0.5

    def test_combined_max(self):
        """All abuse signals → capped at 1.0."""
        score = compute_abuse_score(
            multi_account_same_ip=5,
            rapid_cancel_count=10,
            bot_signature_detected=True,
        )
        assert score == 1.0

    def test_moderate_combination(self):
        score = compute_abuse_score(multi_account_same_ip=3, rapid_cancel_count=3)
        assert abs(score - 0.45) < 0.01


class TestPoolSeatAllocation:
    """Test seat allocation per pool ratio."""

    def test_1000_seats_default_ratios(self):
        seats = compute_pool_seats(1000)
        assert seats[Pool.A] == 650  # Actually gets remainder
        assert seats[Pool.B] == 150
        assert seats[Pool.C] == 100
        assert seats[Pool.D] == 100
        assert sum(seats.values()) == 1000

    def test_total_always_matches(self):
        """Sum of pool seats must always equal total_seats."""
        for total in [1, 10, 100, 500, 999, 1000, 5000, 10000]:
            seats = compute_pool_seats(total)
            assert sum(seats.values()) == total, f"Total mismatch for {total}: got {sum(seats.values())}"

    def test_remainder_goes_to_pool_a(self):
        """Pool A gets any remainder from integer division."""
        seats = compute_pool_seats(100)
        assert seats[Pool.B] == 15
        assert seats[Pool.C] == 10
        assert seats[Pool.D] == 10
        assert seats[Pool.A] == 65  # 100 - 15 - 10 - 10 = 65

    def test_custom_ratios(self):
        custom = {Pool.A: 0.50, Pool.B: 0.20, Pool.C: 0.20, Pool.D: 0.10}
        seats = compute_pool_seats(100, custom)
        assert seats[Pool.B] == 20
        assert seats[Pool.C] == 20
        assert seats[Pool.D] == 10
        assert seats[Pool.A] == 50  # Remainder
        assert sum(seats.values()) == 100

    def test_small_total(self):
        """Even with 1 seat, allocation works."""
        seats = compute_pool_seats(1)
        assert sum(seats.values()) == 1

    def test_allocation_order(self):
        assert POOL_ALLOCATION_ORDER == [Pool.A, Pool.D, Pool.B, Pool.C]


class TestEligibilityDoesNotAffectWeight:
    """
    CRITICAL: Eligibility (Layer 1) must not affect fan weight (Layer 2).
    Verification level determines pool access, not weight value.
    """

    def test_verification_not_in_weight(self):
        """Verify that check_eligibility output has no weight field."""
        user = UserEligibility(
            user_id="u1",
            verification_level=VerificationLevel.REAL_NAME,
        )
        result = check_eligibility(user)
        assert not hasattr(result, "weight")
        assert not hasattr(result, "fan_weight")

    def test_abuse_score_does_not_reduce_weight(self):
        """Abuse score blocks entirely — does not reduce weight."""
        clean = UserEligibility(user_id="u1", verification_level=VerificationLevel.PHONE, abuse_score=0.0)
        borderline = UserEligibility(user_id="u2", verification_level=VerificationLevel.PHONE, abuse_score=0.5)

        result_clean = check_eligibility(clean)
        result_borderline = check_eligibility(borderline)

        # Both pass — and neither result has a "reduced weight"
        assert not result_clean.is_blocked
        assert not result_borderline.is_blocked
        assert set(result_clean.eligible_pools) == set(result_borderline.eligible_pools)
