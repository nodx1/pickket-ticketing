"""
Fan Weight System v2 Tests
===========================
Tests for 5-dimensional fan weight computation,
sigmoid normalization, event templates, and helper functions.
"""

import math
import warnings
import pytest
from talkfile_engine.fan_weight import (
    KAPPA, MU, W_MIN, W_SCALE, ALPHA_MIN, ALPHA_MAX, ALPHA_MAX_BINARY,
    DECAY_LAMBDA, DECAY_HALFLIFE_DAYS,
    EventType, FanScores, AlphaWeights, EVENT_TEMPLATES,
    sigmoid, compute_raw_score, compute_fan_weight_v2,
    compute_history_score, compute_freshness_score,
    compute_behavior_score, compute_loyalty_score,
    validate_template_only,
)


class TestSigmoidFunction:
    """Test the sigmoid function σ(x) = 1/(1+e^(-x))."""

    def test_sigmoid_zero(self):
        assert sigmoid(0.0) == 0.5

    def test_sigmoid_large_positive(self):
        assert sigmoid(100.0) > 0.999

    def test_sigmoid_large_negative(self):
        assert sigmoid(-100.0) < 0.001

    def test_sigmoid_overflow_protection(self):
        assert sigmoid(600.0) == 1.0
        assert sigmoid(-600.0) == 0.0

    def test_sigmoid_symmetry(self):
        """σ(x) + σ(-x) = 1."""
        for x in [0.5, 1.0, 3.0, 6.0]:
            assert abs(sigmoid(x) + sigmoid(-x) - 1.0) < 1e-10


class TestWeightRange:
    """Verify that κ=6 achieves the target weight range [0.57, 1.93]."""

    def test_minimum_weight(self):
        """All scores = 0 → minimum weight ≈ 0.57."""
        scores = FanScores(loyalty=0, history=0, fanclub=0, behavior=0, freshness=0)
        w = compute_fan_weight_v2(scores)
        # w = 0.5 + 1.5 * σ(6*(0 - 0.5)) = 0.5 + 1.5 * σ(-3)
        expected_sigma = sigmoid(KAPPA * (0.0 - MU))
        expected_w = W_MIN + W_SCALE * expected_sigma
        assert abs(w - expected_w) < 1e-4
        assert 0.55 < w < 0.60, f"Min weight should be ~0.57, got {w}"

    def test_maximum_weight(self):
        """All scores = 1 → maximum weight ≈ 1.93."""
        scores = FanScores(loyalty=1, history=1, fanclub=1, behavior=1, freshness=1)
        w = compute_fan_weight_v2(scores)
        expected_sigma = sigmoid(KAPPA * (1.0 - MU))
        expected_w = W_MIN + W_SCALE * expected_sigma
        assert abs(w - expected_w) < 1e-4
        assert 1.90 < w < 1.96, f"Max weight should be ~1.93, got {w}"

    def test_neutral_weight(self):
        """Raw score = 0.5 → weight = 0.5 + 1.5*0.5 = 1.25."""
        scores = FanScores(loyalty=0.5, history=0.5, fanclub=0.5, behavior=0.5, freshness=0.5)
        w = compute_fan_weight_v2(scores)
        assert abs(w - 1.25) < 0.01, f"Neutral weight should be 1.25, got {w}"

    def test_weight_range_comprehensive(self):
        """Weight must always be in [0.5, 2.0] for any valid scores."""
        import random
        random.seed(42)
        for _ in range(1000):
            scores = FanScores(
                loyalty=random.random(),
                history=random.random(),
                fanclub=random.choice([0.0, 1.0]),
                behavior=random.random(),
                freshness=random.random(),
            )
            w = compute_fan_weight_v2(scores)
            assert 0.5 <= w <= 2.0, f"Weight {w} out of [0.5, 2.0]"


class TestColdStart:
    """Test cold start scenarios from the plan."""

    def test_new_user_no_fanclub(self):
        """New user without fanclub: w ≈ 0.85."""
        scores = FanScores(
            loyalty=0.0,
            history=0.0,
            fanclub=0.0,
            behavior=1.0,    # Perfect (new user, no history)
            freshness=1.0,   # Just signed up
        )
        w = compute_fan_weight_v2(scores)
        # Raw = 0.30*0 + 0.25*0 + 0.15*0 + 0.15*1 + 0.15*1 = 0.30
        raw = compute_raw_score(scores, AlphaWeights())
        assert abs(raw - 0.30) < 0.01, f"Raw should be 0.30, got {raw}"
        assert 0.80 < w < 0.90, f"New user no fanclub weight should be ~0.85, got {w}"

    def test_new_user_with_fanclub(self):
        """New user with fanclub: w ≈ 1.14."""
        scores = FanScores(
            loyalty=0.0,
            history=0.0,
            fanclub=1.0,
            behavior=1.0,
            freshness=1.0,
        )
        w = compute_fan_weight_v2(scores)
        # Raw = 0.30*0 + 0.25*0 + 0.15*1 + 0.15*1 + 0.15*1 = 0.45
        raw = compute_raw_score(scores, AlphaWeights())
        assert abs(raw - 0.45) < 0.01, f"Raw should be 0.45, got {raw}"
        assert 1.10 < w < 1.20, f"New user with fanclub weight should be ~1.14, got {w}"

    def test_veteran_fan(self):
        """Veteran fan: high loyalty + history → w ≈ 1.93."""
        scores = FanScores(
            loyalty=1.0,
            history=1.0,
            fanclub=1.0,
            behavior=1.0,
            freshness=0.0,  # Not a new user
        )
        w = compute_fan_weight_v2(scores)
        # Raw = 0.30*1 + 0.25*1 + 0.15*1 + 0.15*1 + 0.15*0 = 0.85
        raw = compute_raw_score(scores, AlphaWeights())
        assert abs(raw - 0.85) < 0.01
        assert w > 1.80, f"Veteran fan weight should be >1.80, got {w}"


class TestEventTemplates:
    """Test event-type specific alpha templates."""

    def test_all_templates_valid(self):
        """Every template must have valid alphas (sum=1, range [0.05,0.65])."""
        for event_type, alphas in EVENT_TEMPLATES.items():
            alphas.validate()  # Should not raise

    def test_general_concert_default(self):
        a = EVENT_TEMPLATES[EventType.GENERAL_CONCERT]
        assert a.loyalty == 0.30
        assert a.history == 0.25
        assert a.fanclub == 0.15
        assert a.behavior == 0.15
        assert a.freshness == 0.15

    def test_fanclub_exclusive_emphasizes_fanclub(self):
        a = EVENT_TEMPLATES[EventType.FANCLUB_EXCLUSIVE]
        assert a.fanclub == 0.40  # At binary max
        assert a.fanclub > a.loyalty
        assert a.fanclub > a.history

    def test_festival_emphasizes_freshness(self):
        a = EVENT_TEMPLATES[EventType.FESTIVAL]
        assert a.freshness == 0.50  # At ALPHA_MAX
        assert a.freshness > a.loyalty

    def test_high_demand_emphasizes_loyalty_history(self):
        a = EVENT_TEMPLATES[EventType.HIGH_DEMAND_TOUR]
        assert a.loyalty == 0.35
        assert a.history == 0.30

    def test_new_artist_emphasizes_freshness(self):
        a = EVENT_TEMPLATES[EventType.NEW_ARTIST]
        assert a.freshness == 0.50  # At ALPHA_MAX (reduced from 0.65)
        assert a.history == 0.05    # Min allowed

    def test_event_type_overrides_default(self):
        """Specifying event_type uses that template."""
        scores = FanScores(loyalty=0.5, history=0.5, fanclub=1.0, behavior=1.0, freshness=0.0)

        w_general = compute_fan_weight_v2(scores, event_type=EventType.GENERAL_CONCERT)
        w_fanclub = compute_fan_weight_v2(scores, event_type=EventType.FANCLUB_EXCLUSIVE)

        # Fanclub exclusive weighs fanclub more → should yield higher weight
        assert w_fanclub > w_general

    def test_custom_alphas_deprecated_uses_template(self):
        """WP04: Custom alphas are deprecated and ignored; event_type template is used."""
        scores = FanScores(loyalty=1.0, history=0.0, fanclub=0.0, behavior=0.5, freshness=0.0)
        custom = AlphaWeights(loyalty=0.50, history=0.10, fanclub=0.10, behavior=0.20, freshness=0.10)

        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            w_with_custom = compute_fan_weight_v2(scores, alphas=custom, event_type=EventType.FESTIVAL)

        # Should use FESTIVAL template, NOT custom alphas
        w_template_only = compute_fan_weight_v2(scores, event_type=EventType.FESTIVAL)
        assert w_with_custom == w_template_only

        # Verify compute_raw_score still works with custom (utility function)
        raw = compute_raw_score(scores, custom)
        # 0.50*1.0 + 0.10*0 + 0.10*0 + 0.20*0.5 + 0.10*0 = 0.60
        assert abs(raw - 0.60) < 0.01


class TestAlphaValidation:
    """Test alpha weight constraints."""

    def test_valid_alphas(self):
        a = AlphaWeights(0.30, 0.25, 0.15, 0.15, 0.15)
        a.validate()  # Should not raise

    def test_sum_not_one(self):
        a = AlphaWeights(0.30, 0.25, 0.15, 0.15, 0.10)  # sum = 0.95
        with pytest.raises(ValueError, match="must equal 1.0"):
            a.validate()

    def test_below_minimum(self):
        a = AlphaWeights(0.50, 0.20, 0.15, 0.11, 0.04)  # 0.04 < 0.05
        with pytest.raises(ValueError, match="outside"):
            a.validate()

    def test_above_maximum_continuous(self):
        a = AlphaWeights(0.55, 0.15, 0.10, 0.15, 0.05)  # 0.55 > ALPHA_MAX=0.50
        with pytest.raises(ValueError, match="outside"):
            a.validate()

    def test_above_maximum_binary(self):
        """Fanclub (binary dim) has stricter limit of 0.40."""
        a = AlphaWeights(0.15, 0.15, 0.45, 0.15, 0.10)  # fanclub 0.45 > ALPHA_MAX_BINARY=0.40
        with pytest.raises(ValueError, match="outside"):
            a.validate()

    def test_edge_case_all_equal(self):
        a = AlphaWeights(0.20, 0.20, 0.20, 0.20, 0.20)
        a.validate()

    def test_edge_case_max_continuous(self):
        a = AlphaWeights(0.50, 0.15, 0.10, 0.15, 0.10)
        a.validate()

    def test_edge_case_max_binary(self):
        a = AlphaWeights(0.20, 0.15, 0.40, 0.15, 0.10)  # fanclub at binary max
        a.validate()


class TestHistoryScore:
    """Test history score with 2-year exponential decay."""

    def test_no_attendance(self):
        assert compute_history_score() == 0.0
        assert compute_history_score([]) == 0.0

    def test_recent_attendance(self):
        """Recent attendance (days_ago=0) gets full weight."""
        score = compute_history_score([(0, 10)])
        assert score > 0.0
        assert score <= 1.0

    def test_decay_over_time(self):
        """Older attendance counts less."""
        score_recent = compute_history_score([(30, 5)])
        score_old = compute_history_score([(1000, 5)])
        assert score_recent > score_old

    def test_2_year_decay_values(self):
        """Verify decay values with true 2-year half-life.

        decay(t) = exp(-ln2 × t / 730)
        At t=730: decay = 0.5 (exact half-life)
        At t=365: decay ≈ 0.707
        At t=1825 (5yr): decay ≈ 0.177
        """
        # True 2-year half-life: exp(-ln2 * t / 730)
        decay_recent = math.exp(-DECAY_LAMBDA * 0)
        decay_1yr = math.exp(-DECAY_LAMBDA * 365)
        decay_2yr = math.exp(-DECAY_LAMBDA * 730)
        decay_5yr = math.exp(-DECAY_LAMBDA * 1825)

        assert abs(decay_recent - 1.0) < 0.001
        assert abs(decay_1yr - 0.707) < 0.01   # sqrt(0.5) ≈ 0.707
        assert abs(decay_2yr - 0.5) < 0.001     # Exact half-life
        assert abs(decay_5yr - 0.177) < 0.01    # 0.5^(1825/730) ≈ 0.177

    def test_capped_at_one(self):
        """Score cannot exceed 1.0."""
        score = compute_history_score([(0, 50), (10, 50), (20, 50)])
        assert score <= 1.0


class TestFreshnessScore:
    """Test freshness (new user bonus) with 6-month linear decay."""

    def test_signup_today(self):
        assert compute_freshness_score(0) == 1.0

    def test_signup_90_days(self):
        assert abs(compute_freshness_score(90) - 0.5) < 0.01

    def test_signup_180_days(self):
        assert compute_freshness_score(180) == 0.0

    def test_signup_over_180_days(self):
        assert compute_freshness_score(365) == 0.0

    def test_negative_days(self):
        """Future signup returns max freshness."""
        assert compute_freshness_score(-1) == 1.0

    def test_linear_decay(self):
        """Score should decrease linearly."""
        scores = [compute_freshness_score(d) for d in range(0, 181, 30)]
        for i in range(len(scores) - 1):
            assert scores[i] > scores[i + 1] or (scores[i] == 0 and scores[i + 1] == 0)


class TestBehaviorScore:
    """Test behavior/trust score."""

    def test_perfect_behavior(self):
        assert compute_behavior_score(0.0, 0.0, 0.0) == 1.0

    def test_worst_behavior(self):
        assert compute_behavior_score(1.0, 1.0, 1.0) == 0.0

    def test_formula(self):
        """s₄ = 1 - (0.5×no_show + 0.3×cancel + 0.2×dispute)."""
        score = compute_behavior_score(0.2, 0.1, 0.05)
        expected = 1.0 - (0.5 * 0.2 + 0.3 * 0.1 + 0.2 * 0.05)
        assert abs(score - expected) < 1e-10

    def test_clamped_to_zero(self):
        """Score cannot go below 0."""
        score = compute_behavior_score(1.0, 1.0, 1.0)
        assert score >= 0.0


class TestLoyaltyScore:
    """Test artist-based loyalty score."""

    def test_no_data_returns_neutral(self):
        """No external data → default 0.5 (neutral)."""
        assert compute_loyalty_score() == 0.5

    def test_max_loyalty(self):
        score = compute_loyalty_score(
            fanclub_tenure_months=60.0,
            listening_hours_yearly=500.0,
            sns_follow_months=36.0,
        )
        assert abs(score - 1.0) < 0.01

    def test_partial_data(self):
        """Only some data available."""
        score = compute_loyalty_score(fanclub_tenure_months=30.0)
        # sub_scores = [30/60=0.5, 0, 0] → mean = 0.5/3 ≈ 0.167
        assert score > 0.0
        assert score < 0.5

    def test_capped_at_one(self):
        """Exceeding normalization max still gives 1.0 sub-score."""
        score = compute_loyalty_score(
            fanclub_tenure_months=120.0,  # > 60 max
            listening_hours_yearly=1000.0,  # > 500 max
            sns_follow_months=72.0,  # > 36 max
        )
        assert abs(score - 1.0) < 0.01


class TestWeightMonotonicity:
    """Higher scores should always produce higher weights."""

    def test_loyalty_increases_weight(self):
        s1 = FanScores(loyalty=0.2, history=0.5, fanclub=0, behavior=1.0, freshness=0)
        s2 = FanScores(loyalty=0.8, history=0.5, fanclub=0, behavior=1.0, freshness=0)
        assert compute_fan_weight_v2(s1) < compute_fan_weight_v2(s2)

    def test_history_increases_weight(self):
        s1 = FanScores(loyalty=0.5, history=0.2, fanclub=0, behavior=1.0, freshness=0)
        s2 = FanScores(loyalty=0.5, history=0.8, fanclub=0, behavior=1.0, freshness=0)
        assert compute_fan_weight_v2(s1) < compute_fan_weight_v2(s2)

    def test_fanclub_increases_weight(self):
        s1 = FanScores(loyalty=0.5, history=0.5, fanclub=0, behavior=1.0, freshness=0)
        s2 = FanScores(loyalty=0.5, history=0.5, fanclub=1, behavior=1.0, freshness=0)
        assert compute_fan_weight_v2(s1) < compute_fan_weight_v2(s2)

    def test_behavior_increases_weight(self):
        s1 = FanScores(loyalty=0.5, history=0.5, fanclub=0, behavior=0.3, freshness=0)
        s2 = FanScores(loyalty=0.5, history=0.5, fanclub=0, behavior=0.9, freshness=0)
        assert compute_fan_weight_v2(s1) < compute_fan_weight_v2(s2)

    def test_freshness_increases_weight(self):
        s1 = FanScores(loyalty=0.5, history=0.5, fanclub=0, behavior=1.0, freshness=0.1)
        s2 = FanScores(loyalty=0.5, history=0.5, fanclub=0, behavior=1.0, freshness=0.9)
        assert compute_fan_weight_v2(s1) < compute_fan_weight_v2(s2)


class TestPriceDiscrimination:
    """Quantify actual price discrimination from weight range."""

    def test_max_price_spread(self):
        """With κ=6, max price ratio ≈ 3.39x."""
        w_min_scores = FanScores(loyalty=0, history=0, fanclub=0, behavior=0, freshness=0)
        w_max_scores = FanScores(loyalty=1, history=1, fanclub=1, behavior=1, freshness=1)

        w_min = compute_fan_weight_v2(w_min_scores)
        w_max = compute_fan_weight_v2(w_max_scores)

        price_ratio = w_max / w_min  # Higher weight pays less, so ratio = w_max/w_min
        assert 3.0 < price_ratio < 4.0, f"Price spread should be ~3.39x, got {price_ratio:.2f}x"

    def test_vcg_price_example(self):
        """From plan: excluded weighted value = 100K.

        w=1.93: pays 100K/1.93 ≈ 51,813
        w=1.00: pays 100K/1.00 = 100,000
        w=0.57: pays 100K/0.57 ≈ 175,439
        """
        excluded_wv = 100_000

        w_max_scores = FanScores(loyalty=1, history=1, fanclub=1, behavior=1, freshness=1)
        w_min_scores = FanScores(loyalty=0, history=0, fanclub=0, behavior=0, freshness=0)

        w_max = compute_fan_weight_v2(w_max_scores)
        w_min = compute_fan_weight_v2(w_min_scores)

        price_loyal = excluded_wv / w_max
        price_min = excluded_wv / w_min

        assert 50_000 < price_loyal < 55_000
        assert 170_000 < price_min < 180_000


class TestValidateTemplateOnly:
    """WP04: Test validate_template_only function."""

    def test_valid_templates(self):
        """All known EventType values should be valid templates."""
        for et in EVENT_TEMPLATES:
            result = validate_template_only(et.value)
            assert result == et

    def test_invalid_template_string(self):
        """Unknown string should raise ValueError."""
        with pytest.raises(ValueError, match="Unknown event type"):
            validate_template_only("totally_invalid_type")

    def test_empty_string(self):
        """Empty string should raise ValueError."""
        with pytest.raises(ValueError, match="Unknown event type"):
            validate_template_only("")

    def test_general_concert(self):
        et = validate_template_only("general_concert")
        assert et == EventType.GENERAL_CONCERT

    def test_sports_match(self):
        et = validate_template_only("sports_match")
        assert et == EventType.SPORTS_MATCH

    def test_all_12_templates(self):
        """All 12 event type values should be valid."""
        expected = [
            "general_concert", "fanclub_exclusive", "festival",
            "high_demand_tour", "new_artist", "sports_match",
            "sports_playoff", "exhibition", "classical", "esports",
            "education", "civic_participation",
        ]
        for val in expected:
            et = validate_template_only(val)
            assert et.value == val


class TestAlphasDeprecation:
    """WP04: Test that custom alphas parameter is deprecated and ignored."""

    def test_alphas_ignored_uses_template(self):
        """When both alphas and event_type are provided, event_type template is used."""
        scores = FanScores(loyalty=1.0, history=0.0, fanclub=0.0, behavior=0.5, freshness=0.0)
        custom = AlphaWeights(loyalty=0.50, history=0.10, fanclub=0.10, behavior=0.20, freshness=0.10)

        # With custom alphas (should be ignored) + festival template
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            w_with_alphas = compute_fan_weight_v2(
                scores, alphas=custom, event_type=EventType.FESTIVAL
            )
            assert len(w) >= 1
            assert issubclass(w[0].category, DeprecationWarning)
            assert "deprecated" in str(w[0].message).lower()

        # Without custom alphas, same event_type
        w_template_only = compute_fan_weight_v2(scores, event_type=EventType.FESTIVAL)

        # Both should produce the same result since alphas is ignored
        assert w_with_alphas == w_template_only

    def test_alphas_none_no_warning(self):
        """No warning when alphas is None (normal usage)."""
        scores = FanScores(loyalty=0.5, history=0.5, fanclub=0.5, behavior=0.5, freshness=0.5)
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            compute_fan_weight_v2(scores, event_type=EventType.GENERAL_CONCERT)
            deprecation_warnings = [x for x in w if issubclass(x.category, DeprecationWarning)]
            assert len(deprecation_warnings) == 0

    def test_default_template_when_no_event_type(self):
        """When neither alphas nor event_type given, GENERAL_CONCERT is used."""
        scores = FanScores(loyalty=0.5, history=0.5, fanclub=0.5, behavior=0.5, freshness=0.5)
        w1 = compute_fan_weight_v2(scores)
        w2 = compute_fan_weight_v2(scores, event_type=EventType.GENERAL_CONCERT)
        assert w1 == w2
