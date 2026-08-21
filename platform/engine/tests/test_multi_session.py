"""
Multi-Session Coordination Tests
==================================
Tests for cross-session policies: session history tracking,
loser bonus calculation, win limits, and weight adjustments.
"""

import pytest
from talkfile_engine.multi_session import (
    SessionRecord,
    SessionHistory,
    compute_loser_bonus,
    check_multi_session_limit,
    apply_cross_session_adjustments,
)


@pytest.fixture
def history():
    """Fresh SessionHistory for each test."""
    return SessionHistory()


def _record(user_id="u1", artist_id="a1", session_number=1,
            event_id="e1", won=False, **kwargs):
    """Helper to build a SessionRecord with sensible defaults."""
    return SessionRecord(
        user_id=user_id,
        artist_id=artist_id,
        session_number=session_number,
        event_id=event_id,
        won=won,
        **kwargs,
    )


class TestSessionHistory:
    """Basic add / query operations."""

    def test_add_and_query_records(self, history):
        """Records are retrievable by artist+user after being added."""
        history.add_record(_record(user_id="u1", artist_id="a1", session_number=1))
        history.add_record(_record(user_id="u1", artist_id="a1", session_number=2))
        history.add_record(_record(user_id="u2", artist_id="a1", session_number=1))

        records = history.get_user_history("a1", "u1")
        assert len(records) == 2
        assert all(r.user_id == "u1" for r in records)

    def test_get_session_records_by_event(self, history):
        """get_session_records() filters by event_id."""
        history.add_record(_record(event_id="e1"))
        history.add_record(_record(event_id="e2"))
        history.add_record(_record(event_id="e1", user_id="u2"))

        records = history.get_session_records("e1")
        assert len(records) == 2

    def test_count_wins(self, history):
        """count_wins() counts only records where won=True."""
        history.add_record(_record(session_number=1, won=True))
        history.add_record(_record(session_number=2, won=False))
        history.add_record(_record(session_number=3, won=True))

        assert history.count_wins("a1", "u1") == 2

    def test_count_losses(self, history):
        """count_losses() counts participated=True and won=False."""
        history.add_record(_record(session_number=1, won=True))
        history.add_record(_record(session_number=2, won=False))
        history.add_record(_record(session_number=3, won=False))

        assert history.count_losses("a1", "u1") == 2


class TestConsecutiveLosses:
    """Tests for count_consecutive_losses()."""

    def test_consecutive_losses_from_most_recent(self, history):
        """Counts backwards from the most recent session."""
        # Session 1: loss, Session 2: win, Session 3: loss, Session 4: loss
        history.add_record(_record(session_number=1, won=False))
        history.add_record(_record(session_number=2, won=True))
        history.add_record(_record(session_number=3, won=False))
        history.add_record(_record(session_number=4, won=False))

        assert history.count_consecutive_losses("a1", "u1") == 2

    def test_win_in_between_resets_count(self, history):
        """A win breaks the consecutive-loss streak."""
        # loss, loss, win (most recent) → 0 consecutive losses
        history.add_record(_record(session_number=1, won=False))
        history.add_record(_record(session_number=2, won=False))
        history.add_record(_record(session_number=3, won=True))

        assert history.count_consecutive_losses("a1", "u1") == 0

    def test_all_losses_counts_all(self, history):
        """If every session is a loss, count equals total sessions."""
        for i in range(1, 5):
            history.add_record(_record(session_number=i, won=False))

        assert history.count_consecutive_losses("a1", "u1") == 4


class TestLoserBonus:
    """Tests for compute_loser_bonus()."""

    def test_bonus_scales_with_consecutive_losses(self, history):
        """Bonus = consecutive_losses * bonus_per_loss."""
        # 3 consecutive losses
        for i in range(1, 4):
            history.add_record(_record(session_number=i, won=False))

        bonus = compute_loser_bonus(history, "u1", "a1", bonus_per_loss=0.05)
        assert bonus == pytest.approx(0.15)

    def test_bonus_capped_at_max(self, history):
        """Bonus never exceeds max_bonus even with many losses."""
        for i in range(1, 11):
            history.add_record(_record(session_number=i, won=False))

        bonus = compute_loser_bonus(
            history, "u1", "a1",
            bonus_per_loss=0.05, max_bonus=0.20,
        )
        assert bonus == pytest.approx(0.20)

    def test_empty_history_zero_bonus(self, history):
        """No records means zero bonus."""
        bonus = compute_loser_bonus(history, "u1", "a1")
        assert bonus == 0.0


class TestMultiSessionLimit:
    """Tests for check_multi_session_limit()."""

    def test_blocks_after_max_wins(self, history):
        """User is ineligible once they hit the win cap."""
        history.add_record(_record(session_number=1, won=True))
        history.add_record(_record(session_number=2, won=True))

        eligible, reason = check_multi_session_limit(history, "u1", "a1", max_wins=2)
        assert eligible is False
        assert "2" in reason

    def test_eligible_under_limit(self, history):
        """User with fewer wins than max is still eligible."""
        history.add_record(_record(session_number=1, won=True))

        eligible, reason = check_multi_session_limit(history, "u1", "a1", max_wins=2)
        assert eligible is True
        assert reason == "Eligible"

    def test_empty_history_eligible(self, history):
        """No history means the user is eligible."""
        eligible, _ = check_multi_session_limit(history, "u1", "a1")
        assert eligible is True


class TestCrossSessionAdjustments:
    """Tests for apply_cross_session_adjustments()."""

    def test_filters_exceeded_users(self, history):
        """Users past the win limit are removed from weights."""
        # u1 has 2 wins (at the default max_wins=2 limit)
        history.add_record(_record(user_id="u1", session_number=1, won=True))
        history.add_record(_record(user_id="u1", session_number=2, won=True))
        # u2 has 0 wins
        history.add_record(_record(user_id="u2", session_number=1, won=False))

        weights = {"u1": 1.0, "u2": 1.0}
        adjusted, filtered = apply_cross_session_adjustments(
            weights, history, "a1", max_wins=2,
        )

        assert "u1" not in adjusted
        assert "u1" in filtered
        assert "u2" in adjusted

    def test_adds_bonus_to_losers(self, history):
        """Eligible losers get their weight boosted."""
        # u1: 2 consecutive losses
        history.add_record(_record(user_id="u1", session_number=1, won=False))
        history.add_record(_record(user_id="u1", session_number=2, won=False))

        weights = {"u1": 1.0}
        adjusted, filtered = apply_cross_session_adjustments(
            weights, history, "a1",
            bonus_per_loss=0.05, max_bonus=0.20,
        )

        assert len(filtered) == 0
        assert adjusted["u1"] == pytest.approx(1.10)  # 1.0 + 2*0.05

    def test_no_history_no_change(self, history):
        """Users with no history get base weight and no filtering."""
        weights = {"u1": 1.0, "u2": 0.8}
        adjusted, filtered = apply_cross_session_adjustments(
            weights, history, "a1",
        )
        assert len(filtered) == 0
        assert adjusted["u1"] == pytest.approx(1.0)
        assert adjusted["u2"] == pytest.approx(0.8)
