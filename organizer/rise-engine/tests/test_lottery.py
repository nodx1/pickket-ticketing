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
