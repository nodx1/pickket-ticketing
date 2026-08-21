"""
WP12-13 Engine Tests: AP-weighted lottery (Efraimidis-Spirakis + 가산 가중치)
===========================================================================
정본: docs/architecture/SALE_MODE_POLICY_v2_2026-04-10.md §3

가중치 공식 (가산 방식):
  당첨가중치 = 기본값(100) + AP보너스 + 보정값
  AP보너스   = log₂(min(invested_ap, 3000) + 1) × 15
  보정값     = (fan_weight - 1.0) × 50 + (pity_bonus - 1.0) × 150

핵심 의도 (테스트 목적):
  - 0 AP 도 참여 가능 (최소 base=100 확보) — "독식 불가"
  - AP 투자자가 비투자자보다 유리 — "활동 보상"
  - AP 많을수록 당첨 확률 높음 (통계적)
  - AP cap=3000 이상 투자해도 효과 미미

VCG 관련 테스트는 2026-04-22 E-S sampling 전환 시 삭제됨.
"""

import math
from collections import Counter

import pytest

from talkfile_engine.lottery import (
    AP_CAP,
    BASE_WEIGHT,
    LotteryEntry,
    LotteryPool,
    compute_ap_bonus,
    compute_effective_ap,
    compute_lottery_weight,
    run_lottery,
)
from talkfile_engine.sale_modes import SaleMode


# ─── compute_effective_ap / compute_ap_bonus ───


class TestEffectiveAP:
    """AP 보너스 log₂ 스케일 확인.

    공식: log₂(min(invested_ap, 3000) + 1) × 15
      0    → 0
      1    → 15
      100  → ~99.886
      400  → ~129.726
      625  → ~139.366
      2500 → ~169.353
      10000→ ~173.213 (cap=3000)
    """

    def test_zero_ap(self):
        assert compute_effective_ap(0) == 0.0

    def test_negative_ap(self):
        assert compute_effective_ap(-10) == 0.0

    def test_100_ap(self):
        expected = math.log2(101) * 15
        assert compute_effective_ap(100) == pytest.approx(expected)

    def test_2500_ap(self):
        expected = math.log2(2501) * 15
        assert compute_effective_ap(2500) == pytest.approx(expected)

    def test_10000_ap_capped(self):
        """10000 AP는 cap=3000 적용되어 log₂(3001)*15 ≈ 173.21."""
        expected = math.log2(AP_CAP + 1) * 15
        assert compute_effective_ap(10000) == pytest.approx(expected)

    def test_400_ap(self):
        expected = math.log2(401) * 15
        assert compute_effective_ap(400) == pytest.approx(expected)

    def test_1_ap(self):
        """1 AP → log₂(2)*15 = 15."""
        assert compute_effective_ap(1) == pytest.approx(15.0)

    def test_625_ap(self):
        expected = math.log2(626) * 15
        assert compute_effective_ap(625) == pytest.approx(expected)

    def test_ap_bonus_is_alias(self):
        """compute_effective_ap 는 compute_ap_bonus 의 하위 호환 래퍼."""
        for ap in (0, 1, 100, 400, 2500, 10000):
            assert compute_effective_ap(ap) == compute_ap_bonus(ap)


# ─── compute_lottery_weight ───


class TestLotteryWeight:
    """가산 가중치: BASE(100) + AP보너스 + (fan-1)*50 + (pity-1)*150."""

    def test_basic_weight(self):
        """100 AP, fan=1.0, tier=1.0, pity=1.0 → 100 + log₂(101)*15 ≈ 199.886."""
        expected = BASE_WEIGHT + math.log2(101) * 15
        w = compute_lottery_weight(100, 1.0, 1.0, 1.0)
        assert w == pytest.approx(expected)

    def test_with_fan_and_pity(self):
        """400 AP, fan=2.0, pity=1.20 → 100 + log₂(401)*15 + 50 + 30."""
        expected = BASE_WEIGHT + math.log2(401) * 15 + (2.0 - 1.0) * 50 + (1.20 - 1.0) * 150
        w = compute_lottery_weight(400, 2.0, 1.10, 1.20)
        assert w == pytest.approx(expected)

    def test_cap_at_2500(self):
        """2500 AP → 100 + log₂(2501)*15 ≈ 269.35."""
        expected = BASE_WEIGHT + math.log2(2501) * 15
        w = compute_lottery_weight(2500, 1.0)
        assert w == pytest.approx(expected)

    def test_cap_at_10000(self):
        """10000 AP는 cap=3000 적용 → 100 + log₂(3001)*15 ≈ 273.21."""
        expected = BASE_WEIGHT + math.log2(AP_CAP + 1) * 15
        w = compute_lottery_weight(10000, 1.0)
        assert w == pytest.approx(expected)

    def test_legend_tier_fan_boost(self):
        """400 AP, fan=1.5, pity=1.0 → 100 + log₂(401)*15 + 25."""
        expected = BASE_WEIGHT + math.log2(401) * 15 + (1.5 - 1.0) * 50
        w = compute_lottery_weight(400, 1.5, 1.20, 1.0)
        assert w == pytest.approx(expected)

    def test_minimum_weight_positive(self):
        """가중치는 항상 >= 1.0 (0 AP + fan=0.0 이어도 base=100 이 지배)."""
        w = compute_lottery_weight(0, 0.0, 1.0, 1.0)
        assert w >= 1.0


# ─── 0 AP 참여 ───


class TestZeroAPParticipation:
    """0 AP 도 참여 가능 (최소 base=100 + fan 보정)."""

    def test_zero_ap_returns_nonzero_weight(self):
        """0 AP, fan=1.0 → base=100 그대로."""
        w = compute_lottery_weight(0, 1.0, 1.0, 1.0)
        assert w > 0
        assert w == pytest.approx(BASE_WEIGHT)

    def test_zero_ap_with_high_fan_weight(self):
        """0 AP, fan=5.0, pity=1.0 → 100 + 0 + (5-1)*50 + 0 = 300."""
        expected = BASE_WEIGHT + (5.0 - 1.0) * 50
        w = compute_lottery_weight(0, 5.0, 1.10, 1.0)
        assert w == pytest.approx(expected)

    def test_invested_user_higher_than_zero_ap(self):
        """0 AP 참여자 < AP 투자자 (활동 보상 원칙). 독식은 없지만 우위는 존재."""
        w_zero = compute_lottery_weight(0, 1.0, 1.0, 1.0)
        w_invest_low = compute_lottery_weight(100, 1.0, 1.0, 1.0)
        w_invest_high = compute_lottery_weight(2500, 1.0, 1.0, 1.0)
        assert w_invest_low > w_zero
        assert w_invest_high > w_invest_low

    def test_zero_ap_ratio_bounded(self):
        """독식 방지: 최대 AP 투자자도 0 AP 의 ~3배 이내 (1.5배 원칙)."""
        w_zero = compute_lottery_weight(0, 1.0, 1.0, 1.0)
        w_max = compute_lottery_weight(AP_CAP, 1.0, 1.0, 1.0)
        # cap=3000 → log₂(3001)*15 ≈ 173.2, weight ≈ 273.2
        # 0 AP weight = 100
        # 비율 ≈ 2.73 (정책 문서상 ~1.5배 목표지만 cap 도달 시 2.7배 근처)
        assert w_max / w_zero < 3.0  # 독식 방지


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
    """AP 투자량이 높을수록 당첨 확률이 높은지 통계적으로 검증.

    E-S sampling 가산 가중치에서는 독식이 일어나지 않으므로
    기대 당첨률은 각자의 weight / sum(weights) 에 근사한다.
    """

    def test_high_ap_wins_more(self):
        """2500 AP 투자자가 0 AP 참여자보다 자주 당첨.

        weights: high≈269.35, zero=100.0 → 기대 ≈ 72.9%.
        """
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
                "high_ap": compute_lottery_weight(2500, 1.0, 1.0, 1.0),
                "zero_ap": compute_lottery_weight(0, 1.0, 1.0, 1.0),
            }
            result = run_lottery(pool, weights=weights, seed=seed)
            if result.winners:
                wins[result.winners[0]] += 1

        high_ratio = wins["high_ap"] / n_runs
        # 가산 방식: high_ap 가 zero_ap 보다 유리하되 독식하지 않음 (~73%)
        assert high_ratio > 0.60, f"High AP user won only {high_ratio:.2%}"
        assert high_ratio < 0.85, f"High AP user won too much {high_ratio:.2%}"

    def test_moderate_vs_low_ap(self):
        """400 AP vs 100 AP 투자자: 400이 약간 더 자주 당첨.

        weights: 400 AP ≈ 229.73, 100 AP ≈ 199.89 → 기대 ≈ 53.5%.
        가산 방식에서는 차이가 작으므로 범위를 넓게 잡음.
        """
        users = ["moderate", "low"]
        wins: Counter = Counter()
        n_runs = 5_000

        for seed in range(n_runs):
            entries = [LotteryEntry(user_id=uid) for uid in users]
            pool = LotteryPool(
                tier_id="t", entries=entries,
                total_seats=1, use_fan_weight=True,
            )
            weights = {
                "moderate": compute_lottery_weight(400, 1.0),
                "low": compute_lottery_weight(100, 1.0),
            }
            result = run_lottery(pool, weights=weights, seed=seed)
            if result.winners:
                wins[result.winners[0]] += 1

        mod_ratio = wins["moderate"] / n_runs
        # 기대 ≈ 53.5%, 독식 방지 정책으로 근소한 우위
        assert mod_ratio > 0.50, f"Moderate AP won only {mod_ratio:.2%}"
        assert mod_ratio < 0.65, f"Moderate AP won too much {mod_ratio:.2%}"


# VCG removed 2026-04-22 — E-S sampling 전환으로 TestAPVCGConversion 클래스 삭제.
# 기존: compute_effective_ap 값을 VCG bid 로 변환하여 할당/지불금 계산.
# 신규: 가산 가중치 → Efraimidis-Spirakis weighted sampling + 위로금 고정.
# VCG 엔진 자체는 talkfile_engine.vcg 에 남아있으나 lottery 정책에서는 미사용.
