"""
Lottery Engine Tests
=====================
Tests for RISE weighted / uniform lottery:
  - Uniform lottery: equal probability
  - Weighted lottery: statistical bias test
  - Seed reproducibility
  - Group lottery: atomic all-or-nothing
  - Group too large for remaining seats -> waitlist
  - Edge cases: empty pool, zero seats, all winners
  - Waitlist ordering
"""

from collections import Counter

import pytest

from talkfile_engine.lottery import LotteryEntry, LotteryPool, LotteryResult, LotteryVerifier, run_lottery


# ─── Helpers ───


def _pool(user_ids: list[str], seats: int, use_fan_weight: bool = True) -> LotteryPool:
    """Build a simple pool of individual entries."""
    entries = [LotteryEntry(user_id=uid) for uid in user_ids]
    return LotteryPool(
        tier_id="tier-vip",
        entries=entries,
        total_seats=seats,
        use_fan_weight=use_fan_weight,
    )


def _group_pool(
    groups: dict[str, list[str]],
    group_sizes: dict[str, int],
    seats: int,
) -> LotteryPool:
    """Build a pool with group entries."""
    entries = []
    for gid, members in groups.items():
        size = group_sizes.get(gid, len(members))
        for uid in members:
            entries.append(LotteryEntry(user_id=uid, group_id=gid, group_size=size))
    return LotteryPool(tier_id="tier-vip", entries=entries, total_seats=seats)


# ─── Uniform lottery ───


class TestUniformLottery:
    """No weights -> all users equal probability."""

    def test_uniform_all_users_have_fair_chance(self):
        """Over many runs each user should win roughly equally often."""
        users = ["A", "B", "C", "D", "E"]
        wins: Counter = Counter()
        n_runs = 5_000
        for seed in range(n_runs):
            pool = _pool(users, seats=1, use_fan_weight=False)
            result = run_lottery(pool, weights=None, seed=seed)
            if result.winners:
                wins[result.winners[0]] += 1

        # Each user should win ~20% of the time.  Accept 14%-26%.
        for uid in users:
            ratio = wins[uid] / n_runs
            assert 0.14 < ratio < 0.26, f"User {uid} won {ratio:.2%} of {n_runs} runs"

    def test_uniform_no_weights_dict(self):
        """Passing weights=None should still work and produce a result."""
        pool = _pool(["u1", "u2", "u3"], seats=2)
        result = run_lottery(pool, weights=None, seed=42)
        assert len(result.winners) == 2
        assert len(result.waitlist) == 1


# ─── Weighted lottery ───


class TestWeightedLottery:
    """Higher weight = more likely to win (statistical test)."""

    def test_weighted_bias(self):
        """User with 10x weight should win substantially more often."""
        users = ["heavy", "light"]
        weights = {"heavy": 10.0, "light": 1.0}
        wins: Counter = Counter()
        n_runs = 3_000
        for seed in range(n_runs):
            pool = _pool(users, seats=1)
            result = run_lottery(pool, weights=weights, seed=seed)
            if result.winners:
                wins[result.winners[0]] += 1

        heavy_ratio = wins["heavy"] / n_runs
        # heavy should win >70% (theoretical ~91% for 10:1)
        assert heavy_ratio > 0.70, f"Heavy user won only {heavy_ratio:.2%}"


# ─── Seed reproducibility ───


class TestSeedReproducibility:
    """Same seed must produce identical results."""

    def test_same_seed_same_result(self):
        pool1 = _pool(["A", "B", "C", "D", "E"], seats=2)
        pool2 = _pool(["A", "B", "C", "D", "E"], seats=2)
        r1 = run_lottery(pool1, weights=None, seed=9999)
        r2 = run_lottery(pool2, weights=None, seed=9999)
        assert r1.winners == r2.winners
        assert r1.waitlist == r2.waitlist
        assert r1.seed_used == r2.seed_used == 9999

    def test_different_seed_likely_different_result(self):
        """Two different seeds should (almost always) give different orderings."""
        results = []
        for seed in [100, 200]:
            pool = _pool([f"u{i}" for i in range(20)], seats=5)
            results.append(run_lottery(pool, weights=None, seed=seed))
        # With 20 users and 5 seats, identical results are astronomically unlikely
        assert results[0].winners != results[1].winners


# ─── Entry order invariance (F-1: 재현성) ───


class TestEntryOrderInvariance:
    """Same seed + same entries in ANY order must give identical results.

    The real path loads entries from PostgreSQL, which does not guarantee
    row order. The engine must therefore sort entries on a stable key
    before consuming any randomness, or recorded seeds cannot reproduce
    the draw for audits.
    """

    def test_entry_order_does_not_change_result(self):
        import random as _r

        users = [f"u{i:02d}" for i in range(30)]
        weights = {uid: 1.0 + (i % 5) * 0.3 for i, uid in enumerate(users)}

        shuffled = list(users)
        _r.Random(7).shuffle(shuffled)

        r_fwd = run_lottery(_pool(users, seats=10), weights=weights, seed=4242)
        r_rev = run_lottery(_pool(list(reversed(users)), seats=10), weights=weights, seed=4242)
        r_shuf = run_lottery(_pool(shuffled, seats=10), weights=weights, seed=4242)

        assert r_fwd.winners == r_rev.winners == r_shuf.winners
        assert r_fwd.waitlist == r_rev.waitlist == r_shuf.waitlist
        assert r_fwd.commitment_hash == r_rev.commitment_hash == r_shuf.commitment_hash

    def test_group_entry_order_does_not_change_result(self):
        def build(reverse: bool) -> LotteryPool:
            entries = [
                LotteryEntry(user_id="s1"),
                LotteryEntry(user_id="s2"),
                LotteryEntry(user_id="g-1", group_id="gA", group_size=2),
                LotteryEntry(user_id="g-2", group_id="gA", group_size=2),
                LotteryEntry(user_id="h-1", group_id="gB", group_size=2),
                LotteryEntry(user_id="h-2", group_id="gB", group_size=2),
            ]
            if reverse:
                entries = list(reversed(entries))
            return LotteryPool(tier_id="t", entries=entries, total_seats=4)

        for seed in range(50):
            r1 = run_lottery(build(False), weights=None, seed=seed)
            r2 = run_lottery(build(True), weights=None, seed=seed)
            assert r1.winners == r2.winners, f"seed={seed}"
            assert r1.waitlist == r2.waitlist, f"seed={seed}"

    def test_order_invariance_with_client_seeds(self):
        users = [f"u{i:02d}" for i in range(20)]
        client_seeds = {"u03": "alpha", "u11": "beta"}

        import random as _r
        shuffled = list(users)
        _r.Random(3).shuffle(shuffled)

        r1 = run_lottery(_pool(users, seats=5), weights=None, seed=999, client_seeds=client_seeds)
        r2 = run_lottery(_pool(shuffled, seats=5), weights=None, seed=999, client_seeds=client_seeds)

        assert r1.seed_used == r2.seed_used
        assert r1.winners == r2.winners
        assert r1.waitlist == r2.waitlist
        assert r1.commitment_hash == r2.commitment_hash


# ─── Group lottery ───


class TestGroupLottery:
    """Atomic all-or-nothing for groups."""

    def test_group_wins_together(self):
        """If a group wins, all members appear in winners."""
        groups = {"g1": ["A", "B"], "g2": ["C", "D"]}
        group_sizes = {"g1": 2, "g2": 2}
        pool = _group_pool(groups, group_sizes, seats=2)
        result = run_lottery(pool, weights=None, seed=42)

        # Exactly one group should win (seats=2, each group needs 2)
        assert len(result.winners) == 2
        assert len(result.waitlist) == 2
        # Winners must be from the same group
        assert set(result.winners) in [{"A", "B"}, {"C", "D"}]

    def test_group_loses_together(self):
        """If a group doesn't fit, all its members go to waitlist."""
        groups = {"g1": ["A", "B"], "g2": ["C", "D"]}
        group_sizes = {"g1": 2, "g2": 2}
        pool = _group_pool(groups, group_sizes, seats=2)
        result = run_lottery(pool, weights=None, seed=42)

        loser_group = set(result.waitlist)
        assert loser_group in [{"A", "B"}, {"C", "D"}]

    def test_group_too_large_for_total_seats(self):
        """A group needing more seats than total available always goes to waitlist."""
        # Group of 3 but only 2 seats total -- group can never fit
        entries = [
            LotteryEntry(user_id="solo"),
            LotteryEntry(user_id="g-1", group_id="big", group_size=3),
            LotteryEntry(user_id="g-2", group_id="big", group_size=3),
            LotteryEntry(user_id="g-3", group_id="big", group_size=3),
        ]
        pool = LotteryPool(tier_id="t", entries=entries, total_seats=2)

        for seed in range(50):
            result = run_lottery(pool, weights=None, seed=seed)
            # Group can never fit, so group always goes to waitlist
            assert set(result.waitlist) == {"g-1", "g-2", "g-3"}
            assert result.winners == ["solo"]

    def test_group_skipped_when_remaining_seats_insufficient(self):
        """Group drawn after solo can't fit in remaining seats and goes to waitlist."""
        # 2 solos + 1 group of 2, only 3 seats total.
        # When solo drawn before group: solo takes 1 seat each, group takes 2 -> fits.
        # But when both solos drawn first: 1 seat left, group can't fit.
        entries = [
            LotteryEntry(user_id="s1"),
            LotteryEntry(user_id="s2"),
            LotteryEntry(user_id="g-1", group_id="gA", group_size=2),
            LotteryEntry(user_id="g-2", group_id="gA", group_size=2),
        ]
        pool = LotteryPool(tier_id="t", entries=entries, total_seats=3)

        group_won = 0
        group_waitlisted = 0
        for seed in range(300):
            p = LotteryPool(tier_id="t", entries=list(entries), total_seats=3)
            result = run_lottery(p, weights=None, seed=seed)
            if "g-1" in result.winners:
                group_won += 1
                # Group must win atomically
                assert "g-2" in result.winners
            else:
                group_waitlisted += 1
                assert set(result.waitlist) == {"g-1", "g-2"}

        # Both outcomes should occur across 300 seeds
        assert group_won > 0, "Group never won across 300 seeds"
        assert group_waitlisted > 0, "Group never waitlisted across 300 seeds"


# ─── Edge cases ───


class TestLotteryEdgeCases:
    """Empty pool, zero seats, everyone wins."""

    def test_empty_pool_returns_empty_result(self):
        pool = LotteryPool(tier_id="t", entries=[], total_seats=10)
        result = run_lottery(pool, seed=1)
        assert result.winners == []
        assert result.waitlist == []
        assert result.total_applicants == 0

    def test_zero_seats_all_go_to_waitlist(self):
        pool = _pool(["A", "B", "C"], seats=0)
        result = run_lottery(pool, seed=1)
        assert result.winners == []
        assert result.total_seats == 0

    def test_all_winners_when_seats_exceed_applicants(self):
        users = ["A", "B", "C"]
        pool = _pool(users, seats=10)
        result = run_lottery(pool, weights=None, seed=42)
        assert set(result.winners) == set(users)
        assert result.waitlist == []

    def test_all_winners_when_seats_equal_applicants(self):
        users = ["A", "B", "C"]
        pool = _pool(users, seats=3)
        result = run_lottery(pool, weights=None, seed=42)
        assert set(result.winners) == set(users)
        assert result.waitlist == []


# ─── Waitlist ordering ───


class TestWaitlistOrdering:
    """Losers should appear in the waitlist in weighted-shuffle order."""

    def test_waitlist_contains_all_non_winners(self):
        users = [f"u{i}" for i in range(10)]
        pool = _pool(users, seats=3)
        result = run_lottery(pool, weights=None, seed=77)
        assert len(result.winners) == 3
        assert len(result.waitlist) == 7
        # No overlap between winners and waitlist
        assert set(result.winners).isdisjoint(set(result.waitlist))
        # Union is the full user set
        assert set(result.winners) | set(result.waitlist) == set(users)

    def test_waitlist_is_deterministic_with_seed(self):
        users = [f"u{i}" for i in range(8)]
        pool1 = _pool(users, seats=2)
        pool2 = _pool(users, seats=2)
        r1 = run_lottery(pool1, weights=None, seed=555)
        r2 = run_lottery(pool2, weights=None, seed=555)
        assert r1.waitlist == r2.waitlist


# ─── Client seed combined lottery (WP01-03) ───


class TestClientSeedCombined:
    """Test client_seeds combined seed derivation."""

    def test_client_seed_combined(self):
        """Client seeds should alter the final seed via SHA-256 derivation."""
        users = ["A", "B", "C", "D", "E"]
        client_seeds = {"A": "seed_a", "B": "seed_b", "C": "seed_c"}

        pool1 = _pool(users, seats=2)
        pool2 = _pool(users, seats=2)

        # Without client seeds
        r_no_cs = run_lottery(pool1, weights=None, seed=42)
        # With client seeds
        r_with_cs = run_lottery(pool2, weights=None, seed=42, client_seeds=client_seeds)

        # The seed used should differ because client_seeds modifies it
        assert r_no_cs.seed_used != r_with_cs.seed_used
        # client_seeds_hash should be set
        assert r_with_cs.client_seeds_hash != ""
        assert r_no_cs.client_seeds_hash == ""

    def test_verification_with_client_seeds(self):
        """Verification data should contain client_seeds when provided."""
        users = ["A", "B", "C"]
        client_seeds = {"A": "my_seed_a", "B": "my_seed_b"}

        pool = _pool(users, seats=2)
        result = run_lottery(pool, weights=None, seed=42, client_seeds=client_seeds)

        assert "client_seeds" in result.verification_data
        assert "client_seeds_hash" in result.verification_data
        assert result.verification_data["seed_derivation_method"] == "sha256(server_seed + sorted_client_seeds)"

        # Verify the commitment hash is valid
        is_valid = LotteryVerifier.verify(result.commitment_hash, result.verification_data)
        assert is_valid is True

    def test_deterministic_with_same_client_seeds(self):
        """Same server seed + same client seeds should produce identical results."""
        users = ["A", "B", "C", "D", "E"]
        client_seeds = {"A": "alpha", "C": "gamma", "E": "epsilon"}

        pool1 = _pool(users, seats=3)
        pool2 = _pool(users, seats=3)

        r1 = run_lottery(pool1, weights=None, seed=1234, client_seeds=client_seeds)
        r2 = run_lottery(pool2, weights=None, seed=1234, client_seeds=client_seeds)

        assert r1.winners == r2.winners
        assert r1.waitlist == r2.waitlist
        assert r1.seed_used == r2.seed_used
        assert r1.commitment_hash == r2.commitment_hash
        assert r1.client_seeds_hash == r2.client_seeds_hash

    def test_different_client_seeds_produce_different_results(self):
        """Different client seeds with same server seed should produce different results."""
        users = [f"u{i}" for i in range(20)]

        cs1 = {"u0": "seed_version_1"}
        cs2 = {"u0": "seed_version_2"}

        pool1 = _pool(users, seats=5)
        pool2 = _pool(users, seats=5)

        r1 = run_lottery(pool1, weights=None, seed=999, client_seeds=cs1)
        r2 = run_lottery(pool2, weights=None, seed=999, client_seeds=cs2)

        # With 20 users and 5 seats, different client seeds should almost always
        # produce different results
        assert r1.seed_used != r2.seed_used
        assert r1.client_seeds_hash != r2.client_seeds_hash

    def test_no_client_seeds_verification_data_has_server_seed_only(self):
        """Without client seeds, verification data should show server_seed_only."""
        pool = _pool(["A", "B"], seats=1)
        result = run_lottery(pool, weights=None, seed=42)

        assert "client_seeds" not in result.verification_data
        assert result.verification_data.get("seed_derivation_method") == "server_seed_only"
        assert result.client_seeds_hash == ""

        # Verification should still work
        is_valid = LotteryVerifier.verify(result.commitment_hash, result.verification_data)
        assert is_valid is True


# ─── Commit-reveal v2 (F-1: 사전 커밋 + 결과 바인딩 + 재계산 검증) ───


class TestCommitRevealV2:
    """Two-phase commit-reveal: pre-draw seed commitment, post-draw reveal
    with entry-snapshot digest and winner binding, full re-run verification."""

    POOL_ID = "pool-cr-001"

    def _commit_then_draw(self, users, seats, *, server_seed, weights=None,
                          client_seeds=None, use_fan_weight=True):
        """① 커밋(추첨 전) → ② 추첨 → (commitment, result) 반환."""
        commitment = LotteryVerifier.compute_seed_commitment(server_seed, self.POOL_ID)
        pool = _pool(users, seats=seats, use_fan_weight=use_fan_weight)
        result = run_lottery(pool, weights=weights, seed=server_seed,
                             client_seeds=client_seeds)
        return commitment, result

    def test_seed_commitment_is_deterministic_and_pool_bound(self):
        c1 = LotteryVerifier.compute_seed_commitment(12345, "pool-a")
        c2 = LotteryVerifier.compute_seed_commitment(12345, "pool-a")
        c3 = LotteryVerifier.compute_seed_commitment(12345, "pool-b")
        c4 = LotteryVerifier.compute_seed_commitment(54321, "pool-a")
        assert c1 == c2
        assert c1 != c3, "pool_id must be bound into the commitment"
        assert c1 != c4, "server_seed must be bound into the commitment"

    def test_result_carries_server_seed_and_v2_bindings(self):
        users = [f"u{i:02d}" for i in range(12)]
        client_seeds = {"u03": "alpha", "u07": "beta"}
        _, result = self._commit_then_draw(
            users, 4, server_seed=777, client_seeds=client_seeds
        )
        # server_seed(reveal 대상)는 결합 시드와 별도로 보존되어야 한다
        assert result.server_seed == 777
        assert result.seed_used == LotteryVerifier.derive_combined_seed(777, client_seeds)
        assert result.seed_used != result.server_seed
        vd = result.verification_data
        assert vd["scheme"] == "commit_reveal_v2"
        assert vd["server_seed"] == 777
        assert vd["winners"] == result.winners
        assert vd["waitlist"] == result.waitlist
        assert vd["entries_digest"] == result.entries_digest != ""

    def test_verify_reveal_happy_path(self):
        users = [f"u{i:02d}" for i in range(15)]
        weights = {u: 1.0 + (i % 5) * 0.2 for i, u in enumerate(users)}
        commitment, result = self._commit_then_draw(
            users, 5, server_seed=424242, weights=weights,
            client_seeds={"u01": "cs1", "u09": "cs9"},
        )
        checks = LotteryVerifier.verify_reveal(
            commitment, self.POOL_ID, result.verification_data
        )
        assert checks["commitment_valid"] is True
        assert checks["entries_digest_valid"] is True
        assert checks["winners_match"] is True
        assert checks["waitlist_match"] is True
        assert checks["is_valid"] is True

    def test_verify_reveal_detects_seed_reroll(self):
        """운영자가 커밋된 시드 대신 다른 시드로 추첨(재추첨)하면 탐지."""
        users = [f"u{i:02d}" for i in range(15)]
        committed_seed = 1000
        commitment = LotteryVerifier.compute_seed_commitment(committed_seed, self.POOL_ID)
        # 추첨은 (마음에 드는 결과가 나온) 다른 시드로 실행 후 그 시드를 공개
        result = run_lottery(_pool(users, seats=5), weights=None, seed=2000)
        checks = LotteryVerifier.verify_reveal(
            commitment, self.POOL_ID, result.verification_data
        )
        assert checks["commitment_valid"] is False
        assert checks["is_valid"] is False

    def test_verify_reveal_detects_winner_substitution(self):
        users = [f"u{i:02d}" for i in range(15)]
        commitment, result = self._commit_then_draw(users, 5, server_seed=31337)
        vd = dict(result.verification_data)
        tampered = list(vd["winners"])
        loser = next(u for u in users if u not in tampered)
        tampered[0] = loser
        vd["winners"] = tampered
        checks = LotteryVerifier.verify_reveal(commitment, self.POOL_ID, vd)
        assert checks["winners_match"] is False
        assert checks["is_valid"] is False

    def test_verify_reveal_detects_entry_tampering(self):
        """공개 후 엔트리 스냅샷(가중치) 조작 시 digest 불일치로 탐지."""
        users = [f"u{i:02d}" for i in range(15)]
        weights = {u: 1.0 for u in users}
        commitment, result = self._commit_then_draw(
            users, 5, server_seed=55555, weights=weights
        )
        vd = dict(result.verification_data)
        entries = [dict(e) for e in vd["entries"]]
        entries[0]["weight"] = 99.0  # 특정 유저 가중치 조작
        vd["entries"] = entries
        checks = LotteryVerifier.verify_reveal(commitment, self.POOL_ID, vd)
        assert checks["entries_digest_valid"] is False
        assert checks["is_valid"] is False

    def test_verify_reveal_detects_result_hash_tampering(self):
        users = [f"u{i:02d}" for i in range(10)]
        commitment, result = self._commit_then_draw(users, 3, server_seed=808)
        vd = dict(result.verification_data)
        vd["result_hash"] = LotteryVerifier.compute_result_hash(
            commitment, 808, vd["entries_digest"], vd["winners"]
        )
        # 정상 바인딩이면 통과
        assert LotteryVerifier.verify_reveal(commitment, self.POOL_ID, vd)["is_valid"]
        # 바인딩 해시 변조 시 실패
        vd["result_hash"] = "0" * 64
        checks = LotteryVerifier.verify_reveal(commitment, self.POOL_ID, vd)
        assert checks["result_hash_valid"] is False
        assert checks["is_valid"] is False

    def test_verify_reveal_incomplete_data_fails_closed(self):
        checks = LotteryVerifier.verify_reveal("abc", self.POOL_ID, {})
        assert checks["reveal_complete"] is False
        assert checks["is_valid"] is False

    def test_use_fan_weight_false_records_weights_actually_used(self):
        """use_fan_weight=False 풀: 추첨도 기록도 w=1.0 — 제3자 재현 일치.

        (구버전은 추첨은 1.0, 기록은 실제 가중치 → 정직한 재현조차 불일치)
        """
        users = [f"u{i:02d}" for i in range(12)]
        skewed = {u: 50.0 if i == 0 else 1.0 for i, u in enumerate(users)}
        commitment, result = self._commit_then_draw(
            users, 4, server_seed=9090, weights=skewed, use_fan_weight=False
        )
        vd = result.verification_data
        assert all(e["weight"] == 1.0 for e in vd["entries"]), (
            "use_fan_weight=False 면 공개 데이터에도 실제 사용된 1.0이 기록되어야 함"
        )
        checks = LotteryVerifier.verify_reveal(commitment, self.POOL_ID, vd)
        assert checks["winners_match"] is True
        assert checks["is_valid"] is True

    def test_third_party_rerun_from_published_data_matches(self):
        """공개 데이터만으로 추첨을 재실행하면 기록된 당첨자와 일치해야 한다."""
        users = [f"u{i:02d}" for i in range(30)]
        weights = {u: 1.0 + (i % 7) * 0.3 for i, u in enumerate(users)}
        _, result = self._commit_then_draw(users, 8, server_seed=246810, weights=weights)
        vd = result.verification_data
        rebuilt = LotteryPool(
            tier_id=vd["tier_id"],
            entries=[
                LotteryEntry(
                    user_id=e["user_id"],
                    group_id=e["group_id"],
                    group_size=e["group_size"],
                )
                for e in vd["entries"]
            ],
            total_seats=vd["capacity"],
            use_fan_weight=True,
        )
        rerun = run_lottery(
            rebuilt,
            weights={e["user_id"]: e["weight"] for e in vd["entries"]},
            seed=vd["server_seed"],
            client_seeds=vd.get("client_seeds"),
        )
        assert rerun.winners == vd["winners"]
        assert rerun.waitlist == vd["waitlist"]


# ─── Commit-reveal v2: pity-exhausted (가중 추첨 미실행) ───


class TestVerifyPityReveal:
    """좌석을 전부 보장당첨(pity)자가 채워 가중 추첨이 실행되지 않은 풀의
    reveal 검증. 재추첨 재현이 아니라 '당첨자 == 바인딩된 보장당첨자 목록 +
    커밋 일치 + 결과 바인딩 일치'를 확인한다."""

    POOL_ID = "pool-pity-001"

    def _build_pity_reveal(self, winner_ids, *, server_seed, capacity):
        """백엔드 _draw_inner 의 pity 소진 경로와 동일하게 reveal 페이로드 구성."""
        commitment = LotteryVerifier.compute_seed_commitment(server_seed, self.POOL_ID)
        canonical_entries = [
            {"user_id": str(u), "weight": 1.0, "group_size": 1, "group_id": None}
            for u in sorted(winner_ids)
        ]
        winners = [str(u) for u in sorted(winner_ids)]
        entries_digest = LotteryVerifier.compute_entries_digest(
            canonical_entries, capacity
        )
        result_hash = LotteryVerifier.compute_result_hash(
            commitment, server_seed, entries_digest, winners
        )
        vd = {
            "scheme": "commit_reveal_v2",
            "draw_mode": LotteryVerifier.DRAW_MODE_PITY_EXHAUSTED,
            "server_seed": server_seed,
            "capacity": capacity,
            "entries": canonical_entries,
            "entries_digest": entries_digest,
            "winners": winners,
            "result_hash": result_hash,
            "tier_id": "tier-1",
        }
        return commitment, vd

    def test_happy_path(self):
        commitment, vd = self._build_pity_reveal(
            ["u02", "u05"], server_seed=12321, capacity=2
        )
        checks = LotteryVerifier.verify_pity_reveal(commitment, self.POOL_ID, vd)
        assert checks["commitment_valid"] is True
        assert checks["entries_digest_valid"] is True
        assert checks["winners_match"] is True
        assert checks["result_hash_valid"] is True
        assert checks["is_valid"] is True

    def test_detects_winner_substitution(self):
        commitment, vd = self._build_pity_reveal(
            ["u02", "u05"], server_seed=999, capacity=2
        )
        vd = dict(vd)
        vd["winners"] = ["u02", "u99"]  # 기록에 없던 user 로 치환
        checks = LotteryVerifier.verify_pity_reveal(commitment, self.POOL_ID, vd)
        assert checks["winners_match"] is False
        assert checks["result_hash_valid"] is False
        assert checks["is_valid"] is False

    def test_detects_seed_reroll(self):
        commitment, vd = self._build_pity_reveal(
            ["u02", "u05"], server_seed=111, capacity=2
        )
        vd = dict(vd)
        vd["server_seed"] = 222  # 커밋과 다른 시드 공개
        checks = LotteryVerifier.verify_pity_reveal(commitment, self.POOL_ID, vd)
        assert checks["commitment_valid"] is False
        assert checks["is_valid"] is False

    def test_detects_entry_tampering(self):
        commitment, vd = self._build_pity_reveal(
            ["u02", "u05"], server_seed=333, capacity=2
        )
        vd = dict(vd)
        entries = [dict(e) for e in vd["entries"]]
        entries[0]["user_id"] = "u77"  # 보장당첨자 스냅샷 조작
        vd["entries"] = entries
        checks = LotteryVerifier.verify_pity_reveal(commitment, self.POOL_ID, vd)
        assert checks["entries_digest_valid"] is False
        assert checks["is_valid"] is False

    def test_incomplete_data_fails_closed(self):
        checks = LotteryVerifier.verify_pity_reveal("abc", self.POOL_ID, {})
        assert checks["reveal_complete"] is False
        assert checks["is_valid"] is False


# ─── Commit-reveal v2: 혼합(pity 보장 + 엔진 가중 추첨) ───


class TestVerifyMixedReveal:
    """일부 좌석은 보장(pity)당첨자가, 나머지는 엔진 가중 추첨이 채운 혼합 풀.

    엔진 재추첨은 가중 추첨 당첨자(winners)만 재현 가능하므로, 보장당첨자는
    verification_data['guaranteed_winners'] 로 별도 기록되어 result_hash 에
    바인딩된다. 보장당첨자 주입/변조 시 result_hash 불일치로 탐지되어야 한다.
    """

    POOL_ID = "pool-mixed-001"

    def _build_mixed_reveal(self, *, engine_users, guaranteed_uids, seats,
                            server_seed):
        """백엔드 _draw_inner 혼합 경로와 동일하게 reveal 페이로드를 구성.

        seats 는 엔진 추첨에 남은 좌석 수(보장당첨 차감 후).
        """
        commitment = LotteryVerifier.compute_seed_commitment(
            server_seed, self.POOL_ID
        )
        pool = _pool(engine_users, seats=seats)
        result = run_lottery(pool, weights=None, seed=server_seed)
        vd = dict(result.verification_data)
        guaranteed_bound = sorted(str(u) for u in guaranteed_uids)
        vd["guaranteed_winners"] = guaranteed_bound
        vd["result_hash"] = LotteryVerifier.compute_result_hash(
            commitment,
            server_seed,
            vd["entries_digest"],
            vd["winners"],
            guaranteed_bound,
        )
        return commitment, vd

    def test_happy_path(self):
        commitment, vd = self._build_mixed_reveal(
            engine_users=[f"u{i:02d}" for i in range(10)],
            guaranteed_uids=["g1", "g2"],
            seats=3,
            server_seed=4242,
        )
        checks = LotteryVerifier.verify_reveal(commitment, self.POOL_ID, vd)
        assert checks["commitment_valid"] is True
        assert checks["entries_digest_valid"] is True
        assert checks["winners_match"] is True
        assert checks["result_hash_valid"] is True
        assert checks["is_valid"] is True

    def test_detects_guaranteed_winner_injection(self):
        """가짜 보장당첨자 주입 → result_hash 불일치로 탐지."""
        commitment, vd = self._build_mixed_reveal(
            engine_users=[f"u{i:02d}" for i in range(10)],
            guaranteed_uids=["g1", "g2"],
            seats=3,
            server_seed=4242,
        )
        # 엔진 당첨자/시드/엔트리 스냅샷은 그대로 두고 보장당첨자 목록만 변조
        vd = dict(vd)
        vd["guaranteed_winners"] = ["g1", "g2", "attacker"]
        checks = LotteryVerifier.verify_reveal(commitment, self.POOL_ID, vd)
        # 엔진 재추첨은 여전히 일치하지만(보장당첨자는 재추첨 대상 아님)…
        assert checks["winners_match"] is True
        # …result_hash 바인딩이 깨져 전체 검증 실패
        assert checks["result_hash_valid"] is False
        assert checks["is_valid"] is False

    def test_detects_guaranteed_winner_removal(self):
        commitment, vd = self._build_mixed_reveal(
            engine_users=[f"u{i:02d}" for i in range(10)],
            guaranteed_uids=["g1", "g2"],
            seats=3,
            server_seed=4242,
        )
        vd = dict(vd)
        vd["guaranteed_winners"] = ["g1"]  # 한 명 제거
        checks = LotteryVerifier.verify_reveal(commitment, self.POOL_ID, vd)
        assert checks["result_hash_valid"] is False
        assert checks["is_valid"] is False

    def test_pure_engine_reveal_is_backward_compatible(self):
        """guaranteed_winners 없는 순수 엔진 추첨: 기존 result_hash 와 동일.

        이 필드가 없을 때 compute_result_hash 가 과거와 같은 해시를 내야
        기존에 기록된 풀의 검증이 깨지지 않는다.
        """
        commitment = LotteryVerifier.compute_seed_commitment(
            707, self.POOL_ID
        )
        result = run_lottery(_pool([f"u{i:02d}" for i in range(8)], seats=3),
                             seed=707)
        vd = result.verification_data
        # 필드 미지정 / None / 빈 리스트 모두 동일 해시
        h_absent = LotteryVerifier.compute_result_hash(
            commitment, 707, vd["entries_digest"], vd["winners"]
        )
        h_none = LotteryVerifier.compute_result_hash(
            commitment, 707, vd["entries_digest"], vd["winners"], None
        )
        h_empty = LotteryVerifier.compute_result_hash(
            commitment, 707, vd["entries_digest"], vd["winners"], []
        )
        assert h_absent == h_none == h_empty
        # 보장당첨자가 있으면 해시가 달라진다(바인딩 증명)
        h_with = LotteryVerifier.compute_result_hash(
            commitment, 707, vd["entries_digest"], vd["winners"], ["g1"]
        )
        assert h_with != h_absent


# ─── 개인 응모 group_size 좌석 회계 (감사 P0-C 오버셀 방어) ───


class TestIndividualGroupSizeSeatAccounting:
    """group_id 없는 개인 응모도 group_size 만큼 좌석을 차감해야 오버셀이 없다.

    소비자 앱 표준 응모는 group_id 없이 group_size(1~4)만 보낸다(메인라인). 엔진이
    이를 항상 1좌석으로 처리하면 당첨 후 서비스가 group_size 장의 티켓·주문을 만들어
    최대 group_size 배의 오버셀이 발생한다(감사 P0-C).
    """

    def test_individual_group_size_no_oversell(self):
        # 좌석 100 · 개인 200명 전원 group_size=2 → 소비 좌석이 총좌석을 넘으면 안 됨
        seats = 100
        entries = [LotteryEntry(user_id=f"U{i}", group_size=2) for i in range(200)]
        pool = LotteryPool(
            tier_id="tier-vip", entries=entries, total_seats=seats, use_fan_weight=False
        )
        result = run_lottery(pool, seed=42)
        # 각 당첨자가 2좌석 소비 → 총 소비 좌석 <= 총좌석 (오버셀 없음)
        assert len(result.winners) * 2 <= seats
        # 좌석을 최대한 채운다(정확히 50명 당첨 = 100좌석)
        assert len(result.winners) == seats // 2
        # 나머지 전원 대기자
        assert len(result.waitlist) == 200 - len(result.winners)
        # 당첨/대기 합이 응모자 전원과 일치(유실 없음)
        assert len(result.winners) + len(result.waitlist) == 200

    def test_individual_group_size_one_is_unchanged(self):
        # group_size=1(기본, orchestrator 경로) 개인은 기존과 동일하게 1좌석 — 무회귀
        seats = 10
        entries = [LotteryEntry(user_id=f"U{i}") for i in range(20)]
        pool = LotteryPool(
            tier_id="t", entries=entries, total_seats=seats, use_fan_weight=False
        )
        result = run_lottery(pool, seed=1)
        assert len(result.winners) == seats
        assert len(result.waitlist) == 10

    def test_mixed_individual_group_sizes_exact_accounting(self):
        # 좌석 10 · 개인 group_size 혼합 → 당첨자 group_size 합이 총좌석을 넘지 않음
        seats = 10
        size_map = {"A": 4, "B": 3, "C": 2, "D": 1, "E": 4, "F": 3}
        entries = [LotteryEntry(user_id=uid, group_size=sz) for uid, sz in size_map.items()]
        pool = LotteryPool(
            tier_id="t", entries=entries, total_seats=seats, use_fan_weight=False
        )
        result = run_lottery(pool, seed=7)
        consumed = sum(size_map[w] for w in result.winners)
        assert consumed <= seats

    def test_individual_group_size_reproducible(self):
        # F-1: 동일 시드 → 동일 결과(결정론) 유지 확인
        entries = [LotteryEntry(user_id=f"U{i}", group_size=3) for i in range(30)]

        def _run():
            pool = LotteryPool(
                tier_id="t", entries=list(entries), total_seats=15, use_fan_weight=False
            )
            return run_lottery(pool, seed=999)

        r1, r2 = _run(), _run()
        assert r1.winners == r2.winners
        assert r1.waitlist == r2.waitlist
        assert sum(3 for _ in r1.winners) <= 15
