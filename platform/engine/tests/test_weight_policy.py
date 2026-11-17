"""가중치 정책(WeightPolicy) — 기본값 회귀, 검증, 해시, 프리셋."""

import random

import pytest

from talkfile_engine.lottery import compute_lottery_weight
from talkfile_engine.weight_policy import (
    ALGORITHM_WEIGHTED_ALLOCATION,
    PRESETS,
    WeightPolicy,
    compute_weight,
    format_weight,
)


class TestDefaultPolicyRegression:
    """기본 정책은 기존 상수 경로와 비트 단위로 같은 가중치를 내야 한다(운영 동작 불변)."""

    def test_bit_identical_on_random_inputs(self):
        rng = random.Random(20261117)
        policy = WeightPolicy()
        for _ in range(5000):
            ap = rng.choice([0, 100, 200, 300, 500, 1000, 2500, 3000, 5000, rng.randint(0, 9999)])
            fan = rng.uniform(0.57, 1.93)
            pity = rng.uniform(1.0, 2.0)
            legacy = compute_lottery_weight(ap, fan, pity_bonus=pity)
            via_policy = compute_lottery_weight(ap, fan, pity_bonus=pity, policy=policy)
            assert legacy == via_policy  # == on floats: 정확히 같은 비트여야 함

    def test_tenure_ignored_when_coef_zero(self):
        policy = WeightPolicy()
        assert compute_weight(policy, 500, 1.2, 1.3, tenure_score=1.0) == compute_lottery_weight(
            500, 1.2, pity_bonus=1.3
        )


class TestPolicyEffects:
    def test_uniform_preset_gives_equal_weights(self):
        p = PRESETS["uniform"]
        weights = {compute_weight(p, ap, fan, pity) for ap, fan, pity in [(0, 1, 1), (3000, 1.9, 1.6), (500, 0.6, 1.0)]}
        assert weights == {100.0}

    def test_tenure_coef_rewards_long_activity(self):
        p = PRESETS["loyalty_first"]
        newbie = compute_weight(p, 300, 1.0, 1.0, tenure_score=0.0)
        veteran = compute_weight(p, 300, 1.0, 1.0, tenure_score=1.0)
        assert veteran - newbie == pytest.approx(80.0)

    def test_tenure_score_is_clamped(self):
        p = WeightPolicy(tenure_coef=50.0)
        assert compute_weight(p, 0, tenure_score=5.0) == compute_weight(p, 0, tenure_score=1.0)
        assert compute_weight(p, 0, tenure_score=-3.0) == compute_weight(p, 0, tenure_score=0.0)

    def test_weight_never_below_one(self):
        p = WeightPolicy(base_weight=1.0, fan_coef=300.0)
        assert compute_weight(p, 0, fan_weight=0.0) == 1.0

    def test_ap_cap_is_respected(self):
        p = WeightPolicy(ap_cap=1000)
        assert compute_weight(p, 1000) == compute_weight(p, 9000)


class TestValidationAndHash:
    def test_rejects_unknown_algorithm(self):
        with pytest.raises(ValueError):
            WeightPolicy(algorithm="auction").validate()

    @pytest.mark.parametrize("field,value", [("fan_coef", -1.0), ("ap_cap", 20000), ("base_weight", 0.0), ("pity_coef", float("nan"))])
    def test_rejects_out_of_range(self, field, value):
        with pytest.raises(ValueError):
            WeightPolicy(**{field: value}).validate()

    def test_hash_changes_with_any_coefficient(self):
        base = WeightPolicy()
        seen = {base.policy_hash()}
        for field, value in [("fan_coef", 51.0), ("pity_coef", 149.0), ("tenure_coef", 1.0), ("algorithm", ALGORITHM_WEIGHTED_ALLOCATION)]:
            h = base.with_changes(**{field: value}).policy_hash()
            assert h not in seen
            seen.add(h)

    def test_round_trip_keeps_hash(self):
        p = WeightPolicy(fan_coef=77.5, tenure_coef=12.0)
        assert WeightPolicy.from_dict(p.to_dict()).policy_hash() == p.policy_hash()

    def test_from_dict_accepts_float_cap(self):
        assert WeightPolicy.from_dict({"ap_cap": 2000.0}).ap_cap == 2000


class TestFormatWeight:
    @pytest.mark.parametrize("w", [100.0, 1.0, 223.45678901234, 100.1, 2 / 3 + 100, 1e15 + 0.5])
    def test_round_trip_exact(self, w):
        assert float(format_weight(w)) == w

    def test_integer_floats_have_no_trailing_zero(self):
        assert format_weight(100.0) == "100"
        assert format_weight(173.5) == "173.5"
