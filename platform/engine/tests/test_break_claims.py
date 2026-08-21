"""
Codex의 5가지 "깨짐" 주장을 코드로 검증.

주장 1: q_i 사용 시 IR 파괴 (x_i* 대신)
주장 2: min_price가 DSIC 깨뜨림
주장 3: stabilization_lambda가 DSIC 깨뜨림
주장 4: 멀티풀이 글로벌 DSIC 깨뜨림
주장 5: w_i가 외생이 아니면 구조적 깨짐
"""

import random
import pytest
from talkfile_engine.vcg import VCGEngine, BidInput, AllocationInput

engine = VCGEngine()


# ============================================================
# 주장 1 검증: q_i vs x_i* — 우리 코드가 실제로 뭘 쓰는가?
# ============================================================

class TestClaim1_QiVsXiStar:
    """Codex 주장: q_i(요청량)를 쓰면 IR 파괴.
    검증: 우리 코드가 실제로 x_i*(배정량)를 쓰는지 증명."""

    def test_codex_exact_counterexample(self):
        """Codex의 정확한 반례:
        K=2, i:(b=10, w=1, q=3), j:(b=9, w=1), k:(b=8, w=1)

        만약 q_i=3 사용 시:
          others_with_i = 20 - 1×10×3 = -10
          m_i = (17 - (-10)) / 1 = 27 > 20 → IR 파괴!

        만약 x_i*=2 사용 시:
          others_with_i = 20 - 1×10×2 = 0
          m_i = (17 - 0) / 1 = 17 ≤ 20 → IR 유지 ✅
        """
        bids = [
            BidInput("i", "ui", 10.0, 1.0, quantity=3),  # 3장 요청
            BidInput("j", "uj", 9.0, 1.0, quantity=1),
            BidInput("k", "uk", 8.0, 1.0, quantity=1),
        ]
        out = engine.allocate(AllocationInput(bids=bids, total_seats=2))

        # i는 2장만 받아야 함 (K=2이고 가장 높은 wv)
        i_winner = next(w for w in out.winners if w.user_id == "ui")

        # weighted_value에서 x_i* 역산
        q_won = round(i_winner.weighted_value / (10.0 * 1.0))
        assert q_won == 2, f"i should win 2 seats, got {q_won}"

        # IR 검증: 총 지불 ≤ b_i × x_i* = 10 × 2 = 20
        total_value = 10.0 * q_won
        assert i_winner.final_price <= total_value + 1e-9, \
            f"IR BROKEN: pays {i_winner.final_price:.2f} > value {total_value:.2f}"

        # 정확한 VCG 가격 검증
        # SW* = 10×2 = 20
        # SW*(-i) = 9+8 = 17 (j,k가 2석 차지)
        # others_with_i = 20 - 10×2 = 0
        # m_i = (17 - 0)/1 = 17, per_unit = 8.5
        assert abs(i_winner.vcg_price - 17.0) < 1e-6, \
            f"VCG price should be 17.0, got {i_winner.vcg_price:.4f}"

    def test_partial_allocation_uses_x_star(self):
        """q_i=5 요청, K=3 → x_i*=3만 배정되어야 함."""
        bids = [
            BidInput("a", "u1", 100.0, 1.0, quantity=5),
            BidInput("b", "u2", 90.0, 1.0, quantity=1),
            BidInput("c", "u3", 80.0, 1.0, quantity=1),
            BidInput("d", "u4", 70.0, 1.0, quantity=1),
        ]
        out = engine.allocate(AllocationInput(bids=bids, total_seats=3))

        u1 = next(w for w in out.winners if w.user_id == "u1")
        q_won = round(u1.weighted_value / (100.0 * 1.0))

        # 3석만 있으므로 최대 3장 배정
        assert q_won == 3, f"Should win 3, got {q_won}"

        # IR: total ≤ 100 × 3 = 300
        assert u1.final_price <= 300.0 + 1e-9

        # q=5를 썼다면: others = SW* - 100*5 = 음수 → 과청구
        # x*=3을 썼으므로: 정상

    def test_q_equals_k_no_overcapacity(self):
        """q_i = K: 한 사람이 모든 석 가져감."""
        bids = [
            BidInput("a", "u1", 100.0, 1.5, quantity=10),
            BidInput("b", "u2", 90.0, 1.0, quantity=1),
            BidInput("c", "u3", 80.0, 1.0, quantity=1),
        ]
        out = engine.allocate(AllocationInput(bids=bids, total_seats=10))
        u1 = next(w for w in out.winners if w.user_id == "u1")
        q_won = round(u1.weighted_value / (100.0 * 1.5))
        # u1의 wv=150 per unit, u2=90, u3=80
        # 10석 중 u1이 최대한 가져감
        assert q_won == 10
        assert u1.final_price <= 100.0 * q_won + 1e-9


# ============================================================
# 주장 2 검증: min_price가 DSIC 깨뜨리는가?
# ============================================================

class TestClaim2_MinPriceBreaksDSIC:
    """Codex 주장: min_price 넣으면 순수 VCG가 아니라 DSIC 깨짐.
    검증: 현재 IR cap + min_price 조합이 실제로 거짓보고 이득을 만드는가?"""

    def test_codex_min_price_counterexample_blocked_by_prefilter(self):
        """Codex의 반례가 사전 필터로 차단되는지 검증.

        진가 100, min_price=95, VCG=90.
        거짓(94): bid=94 < min_price=95 → 사전 필터로 제외 → 당첨 불가.
        따라서 거짓보고가 불가능하게 됨.
        """
        # 시나리오: 진가=100, min_price=95
        bids_truth = [
            BidInput("a", "u1", 100.0, 1.0),
            BidInput("b", "u2", 90.0, 1.0),
        ]
        out_truth = engine.allocate(AllocationInput(
            bids=bids_truth, total_seats=1, min_price=95.0
        ))

        bids_lie = [
            BidInput("a", "u1", 94.0, 1.0),  # 거짓: 94 < min_price=95
            BidInput("b", "u2", 90.0, 1.0),  # 90 < 95, 역시 제외
        ]
        out_lie = engine.allocate(AllocationInput(
            bids=bids_lie, total_seats=1, min_price=95.0
        ))

        true_value = 100.0

        # 진실(100): u1 당첨 (100 ≥ 95), u2 제외 (90 < 95)
        u1_truth = next(w for w in out_truth.winners if w.user_id == "u1")
        util_truth = true_value - u1_truth.final_price
        assert util_truth >= 0, "Truthful bidding should be profitable"

        # 거짓(94): u1 제외 (94 < 95) → 당첨 불가
        u1_lie_winners = [w for w in out_lie.winners if w.user_id == "u1"]
        assert len(u1_lie_winners) == 0, \
            "Lie bid=94 should be excluded by min_price=95 pre-filter"
        util_lie = 0.0  # didn't win

        # SP 유지: 진실 ≥ 거짓
        assert util_truth >= util_lie, \
            f"SP broken: truth={util_truth}, lie={util_lie}"

    def test_min_price_sp_random_search(self):
        """1000 랜덤 시나리오에서 min_price + IR cap SP 위반 찾기."""
        rng = random.Random(42)
        violations = []

        for trial in range(1000):
            n = rng.randint(2, 6)
            k = rng.randint(1, max(1, n - 1))
            liar = rng.randint(0, n - 1)

            true_vals = [rng.uniform(50, 200) for _ in range(n)]
            min_price = rng.uniform(30, 150)

            bids_truth = [
                BidInput(f"b{i}", f"u{i}", true_vals[i], 1.0)
                for i in range(n)
            ]
            out_truth = engine.allocate(AllocationInput(
                bids=bids_truth, total_seats=k, min_price=min_price
            ))

            # 거짓: min_price 바로 아래로 입찰 (IR cap 악용 시도)
            lie_val = min_price - rng.uniform(0.5, 5.0)
            if lie_val <= 0:
                continue

            bids_lie = list(bids_truth)
            bids_lie[liar] = BidInput(f"b{liar}", f"u{liar}", lie_val, 1.0)
            out_lie = engine.allocate(AllocationInput(
                bids=bids_lie, total_seats=k, min_price=min_price
            ))

            liar_id = f"u{liar}"
            tv = true_vals[liar]

            util_truth = sum(tv - w.final_price for w in out_truth.winners if w.user_id == liar_id)
            util_lie = sum(tv - w.final_price for w in out_lie.winners if w.user_id == liar_id)

            if util_lie > util_truth + 1e-6:
                violations.append({
                    "trial": trial,
                    "true_val": tv,
                    "lie_val": lie_val,
                    "min_price": min_price,
                    "util_truth": util_truth,
                    "util_lie": util_lie,
                })

        # 위반이 발견되면 보고 (현재 IR cap 때문에 발견될 수 있음)
        if violations:
            pytest.fail(
                f"min_price SP violations: {len(violations)}\n"
                f"First: {violations[0]}"
            )


# ============================================================
# 주장 3 검증: stabilization_lambda가 DSIC 깨뜨리는가?
# ============================================================

class TestClaim3_StabilizationBreaksDSIC:
    """Codex 주장: stabilization이 Groves 구조를 파괴.
    검증: 실제로 거짓보고가 이득인 시나리오가 존재하는가?"""

    def test_stabilization_sp_5000_random(self):
        """5000 랜덤 시나리오에서 stabilization SP 위반 탐색."""
        rng = random.Random(999)
        violations = []

        for trial in range(5000):
            n = rng.randint(3, 10)
            k = rng.randint(1, n - 1)
            liar = rng.randint(0, n - 1)
            lam = rng.uniform(0.1, 1.0)  # stabilization parameter

            true_vals = [rng.uniform(10, 500) for _ in range(n)]
            weights = [rng.uniform(0.57, 1.93) for _ in range(n)]

            bids_truth = [
                BidInput(f"b{i}", f"u{i}", true_vals[i], weights[i])
                for i in range(n)
            ]
            out_truth = engine.allocate(AllocationInput(
                bids=bids_truth, total_seats=k, stabilization_lambda=lam
            ))

            lie_val = rng.uniform(0.01, 2000)
            bids_lie = list(bids_truth)
            bids_lie[liar] = BidInput(f"b{liar}", f"u{liar}", lie_val, weights[liar])
            out_lie = engine.allocate(AllocationInput(
                bids=bids_lie, total_seats=k, stabilization_lambda=lam
            ))

            liar_id = f"u{liar}"
            tv = true_vals[liar]

            util_truth = sum(tv - w.final_price for w in out_truth.winners if w.user_id == liar_id)
            util_lie = sum(tv - w.final_price for w in out_lie.winners if w.user_id == liar_id)

            if util_lie > util_truth + 1e-6:
                violations.append({
                    "trial": trial,
                    "true_val": tv,
                    "lie_val": lie_val,
                    "lambda": lam,
                    "util_truth": util_truth,
                    "util_lie": util_lie,
                    "gain": util_lie - util_truth,
                })

        if violations:
            pytest.fail(
                f"Stabilization SP violations: {len(violations)}\n"
                f"First: {violations[0]}"
            )
        # 위반 0건이면 → 실전적으로 stabilization은 SP를 깨지 않음

    def test_stabilization_never_below_vcg(self):
        """DSIC-preserving stabilization: prices never go below VCG.
        Median compression pulls low prices UP and high prices DOWN toward
        median, but VCG floor prevents going below original VCG price."""
        rng = random.Random(123)
        for _ in range(1000):
            n = rng.randint(3, 10)
            k = rng.randint(1, n - 1)
            lam = rng.uniform(0.1, 2.0)

            bids = [
                BidInput(f"b{i}", f"u{i}", rng.uniform(10, 500), rng.uniform(0.5, 2.0))
                for i in range(n)
            ]
            out_with_stab = engine.allocate(AllocationInput(
                bids=bids, total_seats=k, stabilization_lambda=lam
            ))

            for w in out_with_stab.winners:
                # final_price ≥ vcg_price (VCG floor guarantees DSIC)
                assert w.final_price >= w.vcg_price - 1e-9, \
                    f"Below VCG floor: {w.final_price} < {w.vcg_price}"
                # final_price ≤ bid (IR preserved)
                assert w.final_price <= w.bid_amount + 1e-9, \
                    f"IR broken: {w.final_price} > {w.bid_amount}"


# ============================================================
# 주장 2 수정 후 검증: min_price 사전 필터링
# ============================================================

class TestClaim2_AfterFix:
    """min_price 사전 필터링 후 SP 복원 검증."""

    def test_min_price_prefilter_restores_sp(self):
        """사전 필터링: bid < min_price인 입찰 제외.
        이후 max(VCG, min_price) ≤ bid가 자연스럽게 보장."""
        # 진가=100, min_price=95
        # 필터 후: bid=100 ≥ 95 → 참여
        # 거짓 bid=94 < 95 → 제외 → 당첨 불가 → 거짓이 불리
        bids = [
            BidInput("a", "u1", 100.0, 1.0),
            BidInput("b", "u2", 90.0, 1.0),
        ]
        out = engine.allocate(AllocationInput(
            bids=bids, total_seats=1, min_price=95.0
        ))

        u1 = next((w for w in out.winners if w.user_id == "u1"), None)
        if u1:
            # min_price 필터 후: bid=100 ≥ 95, payment = max(VCG, 95)
            # VCG = 90, payment = 95 ≤ 100 → IR ✅
            assert u1.final_price <= 100.0 + 1e-9

    def test_prefilter_sp_5000_random(self):
        """사전 필터링 적용 후 5000 랜덤 SP 테스트."""
        rng = random.Random(42)
        violations = []

        for trial in range(5000):
            n = rng.randint(2, 8)
            k = rng.randint(1, max(1, n - 1))
            liar = rng.randint(0, n - 1)
            min_price = rng.uniform(0, 100)

            true_vals = [rng.uniform(50, 300) for _ in range(n)]
            weights = [rng.uniform(0.57, 1.93) for _ in range(n)]

            bids_truth = [
                BidInput(f"b{i}", f"u{i}", true_vals[i], weights[i])
                for i in range(n)
            ]
            out_truth = engine.allocate(AllocationInput(
                bids=bids_truth, total_seats=k, min_price=min_price
            ))

            lie_val = rng.uniform(0.01, 1000)
            bids_lie = list(bids_truth)
            bids_lie[liar] = BidInput(f"b{liar}", f"u{liar}", lie_val, weights[liar])
            out_lie = engine.allocate(AllocationInput(
                bids=bids_lie, total_seats=k, min_price=min_price
            ))

            liar_id = f"u{liar}"
            tv = true_vals[liar]

            util_truth = sum(tv - w.final_price for w in out_truth.winners if w.user_id == liar_id)
            util_lie = sum(tv - w.final_price for w in out_lie.winners if w.user_id == liar_id)

            if util_lie > util_truth + 1e-6:
                violations.append({
                    "trial": trial,
                    "true_val": tv,
                    "lie_val": lie_val,
                    "min_price": min_price,
                    "util_truth": util_truth,
                    "util_lie": util_lie,
                })

        assert len(violations) == 0, \
            f"SP still broken after fix! {len(violations)} violations\nFirst: {violations[0]}"
