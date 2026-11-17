"""가중 VCG 배분 모드 — 배분, 가격, 개인 합리성, 재현성, 동점 처리, 전략적 정직성."""

import random

import pytest

from talkfile_engine.vcg_allocation import (
    VcgEntry,
    run_weighted_vcg,
    tiebreak_key,
    verify_weighted_vcg,
)
from talkfile_engine.weight_policy import WeightPolicy

POLICY = WeightPolicy(algorithm="weighted_allocation")


def _entries(spec):
    return [VcgEntry(user_id=u, bid_ap=b, weight=w) for u, b, w in spec]


class TestAllocation:
    def test_highest_weighted_values_win(self):
        entries = _entries([("a", 1000, 1.0), ("b", 500, 3.0), ("c", 900, 1.0), ("d", 100, 1.0)])
        # 가중 가치: a=1000, b=1500, c=900, d=100 → 2석이면 b, a
        r = run_weighted_vcg(entries, 2, seed=7, policy=POLICY)
        assert r.winners == ["b", "a"]
        assert r.waitlist == ["c", "d"]

    def test_second_price_payment(self):
        entries = _entries([("a", 1000, 1.0), ("b", 500, 3.0), ("c", 900, 1.0)])
        r = run_weighted_vcg(entries, 2, seed=7, policy=POLICY)
        # 탈락자 최고 가중 가치 = 900 → a: 900/1=900, b: 900/3=300
        assert r.charges == {"b": 300, "a": 900}

    def test_payment_never_exceeds_bid(self):
        rng = random.Random(1)
        for _ in range(200):
            entries = [VcgEntry(f"u{i}", rng.choice(range(0, 2600, 100)), rng.uniform(1, 400)) for i in range(30)]
            r = run_weighted_vcg(entries, 10, seed=rng.randint(0, 2**60), policy=POLICY)
            by = {e.user_id: e for e in entries}
            for uid, charge in r.charges.items():
                assert 0 <= charge <= by[uid].bid_ap

    def test_all_win_when_seats_exceed_entries(self):
        entries = _entries([("a", 300, 1.0), ("b", 200, 1.0)])
        r = run_weighted_vcg(entries, 5, seed=1, policy=POLICY)
        assert set(r.winners) == {"a", "b"}
        assert r.charges == {"a": 0, "b": 0}  # 경쟁자 없음 → 가격 0
        assert r.waitlist == []

    def test_no_entries(self):
        r = run_weighted_vcg([], 3, seed=1, policy=POLICY)
        assert r.winners == [] and r.waitlist == []

    def test_duplicate_user_rejected(self):
        with pytest.raises(ValueError):
            run_weighted_vcg(_entries([("a", 100, 1.0), ("a", 200, 1.0)]), 1, seed=1, policy=POLICY)


class TestTieBreakAndReproducibility:
    def test_ties_are_broken_by_committed_seed(self):
        entries = _entries([(f"u{i}", 0, 100.0) for i in range(20)])  # 전원 0 AP → 전원 동점
        r1 = run_weighted_vcg(entries, 5, seed=11, policy=POLICY)
        r2 = run_weighted_vcg(entries, 5, seed=11, policy=POLICY)
        r3 = run_weighted_vcg(entries, 5, seed=12, policy=POLICY)
        assert r1.winners == r2.winners  # 같은 시드 → 같은 결과
        assert r1.winners != r3.winners  # 다른 시드 → 다른 동점 순서
        expected = sorted((e.user_id for e in entries), key=lambda u: tiebreak_key(11, u))[:5]
        assert r1.winners == expected

    def test_input_order_does_not_matter(self):
        entries = _entries([(f"u{i}", (i % 7) * 100, 1 + (i % 3)) for i in range(40)])
        shuffled = entries[:]
        random.Random(3).shuffle(shuffled)
        a = run_weighted_vcg(entries, 12, seed=99, policy=POLICY)
        b = run_weighted_vcg(shuffled, 12, seed=99, policy=POLICY)
        assert a.winners == b.winners and a.charges == b.charges

    def test_verify_accepts_honest_and_rejects_tampered(self):
        entries = _entries([(f"u{i}", (i % 9) * 100, 1 + (i % 4) * 0.5) for i in range(25)])
        r = run_weighted_vcg(entries, 8, seed=5, policy=POLICY)
        assert verify_weighted_vcg(entries, 8, 5, POLICY, r.winners, r.charges)
        tampered = r.waitlist[:1] + r.winners[1:]
        assert not verify_weighted_vcg(entries, 8, 5, POLICY, tampered)
        assert not verify_weighted_vcg(entries, 8, 5, POLICY, r.winners, {**r.charges, r.winners[0]: 0})


class TestTruthfulness:
    """λ=0 순수 VCG: 자기 가치대로 투입하는 것이 최선이다(과대·과소 투입으로 이득 없음)."""

    def test_no_profitable_deviation(self):
        rng = random.Random(42)
        for trial in range(60):
            values = {f"u{i}": rng.choice(range(100, 2600, 100)) for i in range(12)}
            weights = {u: rng.uniform(1, 3) for u in values}
            seats = 4
            me = "u0"

            def utility(bid):
                entries = [VcgEntry(u, (bid if u == me else v), weights[u]) for u, v in values.items()]
                r = run_weighted_vcg(entries, seats, seed=trial, policy=POLICY)
                return values[me] - r.charges[me] if me in r.winners else 0

            truthful = utility(values[me])
            for alt in range(0, 2600, 100):
                # 정수 올림(최대 1 AP) 이내의 차이만 허용
                assert utility(alt) <= truthful + 1, (trial, alt)

    def test_strategy_proof_flag_for_pure_vcg(self):
        entries = _entries([("a", 1000, 1.0), ("b", 500, 3.0), ("c", 900, 1.0)])
        assert run_weighted_vcg(entries, 2, seed=1, policy=POLICY).is_strategy_proof
