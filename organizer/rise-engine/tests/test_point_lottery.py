"""
Point-lottery engine tests (canonical additive-weight engine).
================================================================
정본 동기화(감사 idx9) 이후 rise-engine 은 platform/engine 정본과
동일한 *가산* 가중치 엔진을 사용한다:

    당첨가중치 = BASE_WEIGHT(100) + AP보너스(log₂ 스케일) + 보정값

구버전의 곱셈 가중치(P = w/Σw)·sqrt 캡(50)·"POINT_LOTTERY는 VCG 사용"
가정은 폐기됐다(DOMAIN_MODEL_STANDARD: point_lottery 에서 VCG 금지).
이 테스트는 정본 가산 가중치 계약을 검증한다.
"""

import math
from collections import Counter

import pytest

from talkfile_engine.lottery import (
    AP_CAP,
    AP_SCALE,
    BASE_WEIGHT,
    LotteryEntry,
    LotteryPool,
    compute_ap_bonus,
    compute_effective_ap,
    compute_lottery_weight,
    run_lottery,
)
from talkfile_engine.sale_modes import SaleMode


# ─── compute_ap_bonus (로그 스케일, 가산) ───


class TestAPBonus:
    """AP 보너스 = log₂(min(AP, 3000)+1) × 15. 곱셈 sqrt 캡이 아니다."""

    def test_zero_ap(self):
        assert compute_ap_bonus(0) == 0.0

    def test_negative_ap(self):
        assert compute_ap_bonus(-10) == 0.0

    def test_monotonic_increasing(self):
        assert compute_ap_bonus(100) < compute_ap_bonus(1000) < compute_ap_bonus(3000)

    def test_matches_formula(self):
        expected = math.log2(300 + 1) * AP_SCALE
        assert compute_ap_bonus(300) == pytest.approx(expected)

    def test_capped_at_ap_cap(self):
        """AP_CAP(3000) 초과 투자는 효과 동일 (상한)."""
        assert compute_ap_bonus(10000) == pytest.approx(compute_ap_bonus(AP_CAP))

    def test_effective_ap_is_alias_of_bonus(self):
        """compute_effective_ap 는 하위 호환 wrapper — compute_ap_bonus 와 동일."""
        for ap in (0, 100, 1000, 5000):
            assert compute_effective_ap(ap) == compute_ap_bonus(ap)


# ─── compute_lottery_weight (가산 방식) ───


class TestLotteryWeight:
    """당첨가중치 = BASE_WEIGHT + AP보너스 + fan/pity 보정값."""

    def test_zero_ap_base_weight(self):
        """0 AP, 중립 fan/pity -> BASE_WEIGHT(100). 독식 불가의 핵심."""
        w = compute_lottery_weight(0, 1.0, 1.0, 1.0)
        assert w == pytest.approx(BASE_WEIGHT)

    def test_ap_adds_bonus_additively(self):
        """투자 AP 는 보너스를 *가산* — 100 + ap_bonus(2000)."""
        w = compute_lottery_weight(2000, 1.0, 1.0, 1.0)
        assert w == pytest.approx(BASE_WEIGHT + compute_ap_bonus(2000))

    def test_fan_weight_adjustment(self):
        """fan_weight 보정 = (fan-1)*50, 가산."""
        w = compute_lottery_weight(0, 1.5, 1.0, 1.0)
        assert w == pytest.approx(BASE_WEIGHT + (1.5 - 1.0) * 50)

    def test_pity_adjustment(self):
        """pity_bonus 보정 = (pity-1)*150, 가산."""
        w = compute_lottery_weight(0, 1.0, 1.0, 1.4)
        assert w == pytest.approx(BASE_WEIGHT + (1.4 - 1.0) * 150)

    def test_no_winner_take_all(self):
        """0 AP vs 최대 AP 가중치 비율은 약 1.5~2배 — 독식 불가 보장."""
        w_zero = compute_lottery_weight(0, 1.0, 1.0, 1.0)
        w_max = compute_lottery_weight(AP_CAP, 1.0, 1.0, 1.0)
        ratio = w_max / w_zero
        assert 1.3 < ratio < 3.0, f"독식 위험: 비율 {ratio:.2f}"

    def test_minimum_weight_positive(self):
        """가중치는 항상 1 이상."""
        w = compute_lottery_weight(0, 0.0, 1.0, 1.0)
        assert w >= 1.0


# ─── 0 AP 참여 ───


class TestZeroAPParticipation:
    """0 AP 투자자도 BASE_WEIGHT 로 의미있게 참여 (구버전 0.1 페널티 폐기)."""

    def test_zero_ap_gets_base_weight(self):
        w = compute_lottery_weight(0, 1.0, 1.0, 1.0)
        assert w == pytest.approx(BASE_WEIGHT)

    def test_invested_higher_but_not_dominant(self):
        w_zero = compute_lottery_weight(0, 1.0, 1.0, 1.0)
        w_invest = compute_lottery_weight(2000, 1.0, 1.0, 1.0)
        assert w_invest > w_zero
        # 독식 불가: 투자자가 무투자자를 10배 이상 압도하지 않음
        assert w_invest < w_zero * 3


# ─── POINT_LOTTERY sale mode ───


class TestPointLotterySaleMode:
    """POINT_LOTTERY가 SaleMode enum에 포함됐는지 확인."""

    def test_point_lottery_exists(self):
        assert hasattr(SaleMode, "POINT_LOTTERY")
        assert SaleMode.POINT_LOTTERY.value == "point_lottery"

    def test_all_sale_modes_present(self):
        modes = {m.value for m in SaleMode}
        expected = {
            "fixed_fcfs", "point_lottery", "fanclub_presale",
        }
        assert expected == modes


# ─── AP-weighted lottery statistical bias ───


class TestAPWeightedLotteryBias:
    """AP 투자량이 높을수록 당첨 확률이 높되, 독식하지 않음을 검증."""

    def test_high_ap_wins_more_but_not_all(self):
        """최대 AP 투자자가 무투자자보다 자주 당첨하지만 독식하지 않는다."""
        users = ["high_ap", "zero_ap"]
        wins: Counter = Counter()
        n_runs = 3_000

        for seed in range(n_runs):
            entries = [LotteryEntry(user_id=uid) for uid in users]
            pool = LotteryPool(
                tier_id="tier-vip", entries=entries,
                total_seats=1, use_fan_weight=True,
            )
            weights = {
                "high_ap": compute_lottery_weight(AP_CAP, 1.0, 1.0, 1.0),
                "zero_ap": compute_lottery_weight(0, 1.0, 1.0, 1.0),
            }
            result = run_lottery(pool, weights=weights, seed=seed)
            if result.winners:
                wins[result.winners[0]] += 1

        high_ratio = wins["high_ap"] / n_runs
        # 가산 가중치: high ≈ 100+173 = 273, zero = 100 -> ~73% 당첨
        assert high_ratio > 0.55, f"고 AP 당첨률 {high_ratio:.2%}"
        assert high_ratio < 0.85, f"고 AP 독식 {high_ratio:.2%} (독식 불가 위반)"

    def test_determinism_same_seed(self):
        """동일 시드+동일 입력 -> 동일 결과 (결정론성)."""
        users = ["a", "b", "c"]
        weights = {
            "a": compute_lottery_weight(2000, 1.0),
            "b": compute_lottery_weight(500, 1.0),
            "c": compute_lottery_weight(0, 1.0),
        }

        def draw():
            entries = [LotteryEntry(user_id=uid) for uid in users]
            pool = LotteryPool(tier_id="t", entries=entries, total_seats=1)
            return run_lottery(pool, weights=weights, seed=12345).winners

        assert draw() == draw()
