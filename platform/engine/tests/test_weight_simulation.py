"""가중치 정책 미리보기 시뮬레이션."""

import pytest

from talkfile_engine.weight_policy import PRESETS, WeightPolicy
from talkfile_engine.weight_simulation import DEFAULT_PROFILES, Profile, simulate


def _by_key(result):
    return {p["key"]: p for p in result["profiles"]}


def test_uniform_policy_gives_equal_probability():
    r = simulate(PRESETS["uniform"], DEFAULT_PROFILES, seats=100, iterations=800)
    probs = [p["win_probability"] for p in r["profiles"]]
    expected = 100 / sum(p.count for p in DEFAULT_PROFILES)
    for prob in probs:
        assert prob == pytest.approx(expected, abs=0.03)


def test_expected_winners_sum_to_seats():
    r = simulate(WeightPolicy(), DEFAULT_PROFILES, seats=120, iterations=400)
    assert sum(p["expected_winners"] for p in r["profiles"]) == pytest.approx(120, abs=0.5)


def test_loyalty_preset_raises_veteran_probability():
    base = _by_key(simulate(WeightPolicy(), DEFAULT_PROFILES, seats=100, iterations=600))
    loyal = _by_key(simulate(PRESETS["loyalty_first"], DEFAULT_PROFILES, seats=100, iterations=600))
    assert loyal["veteran"]["win_probability"] > base["veteran"]["win_probability"]
    assert loyal["newcomer"]["win_probability"] < base["newcomer"]["win_probability"]


def test_allocation_mode_is_deterministic_by_weighted_value():
    policy = WeightPolicy(algorithm="weighted_allocation")
    profiles = [Profile("hi", "hi", 10, invested_ap=2000), Profile("lo", "lo", 10, invested_ap=100)]
    r = _by_key(simulate(policy, profiles, seats=15))
    assert r["hi"]["win_probability"] == 1.0
    assert r["lo"]["win_probability"] == pytest.approx(0.5)


def test_all_win_when_enough_seats():
    r = simulate(WeightPolicy(), DEFAULT_PROFILES, seats=10_000)
    assert all(p["win_probability"] == 1.0 for p in r["profiles"])


def test_rejects_huge_population():
    with pytest.raises(ValueError):
        simulate(WeightPolicy(), [Profile("x", "x", 300_000)], seats=10)
