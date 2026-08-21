"""
RISE Multi-Session Coordination
=================================
Manages cross-session (tour) policies for multi-date events.

Features:
  - Loser bonus: previous session losers get weight bonus (+0.05 per loss)
  - Duplicate win limit: max N wins per user across sessions
  - Session history tracking
"""

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class SessionRecord:
    """Record of a user's participation in one session."""
    user_id: str
    artist_id: str
    session_number: int
    event_id: str
    participated: bool = True
    won: bool = False
    tier_id: str = ""
    price_paid: float = 0.0
    timestamp: datetime | None = None


class SessionHistory:
    """In-memory session history store."""

    def __init__(self):
        self._records: list[SessionRecord] = []

    def add_record(self, record: SessionRecord) -> None:
        """Add a session participation record."""
        self._records.append(record)

    def get_user_history(
        self, artist_id: str, user_id: str
    ) -> list[SessionRecord]:
        """Get all records for a user + artist combination."""
        return [
            r for r in self._records
            if r.artist_id == artist_id and r.user_id == user_id
        ]

    def get_session_records(
        self, event_id: str
    ) -> list[SessionRecord]:
        """Get all records for a specific session/event."""
        return [r for r in self._records if r.event_id == event_id]

    def count_wins(self, artist_id: str, user_id: str) -> int:
        """Count total wins for a user across all sessions of an artist."""
        return sum(
            1 for r in self._records
            if r.artist_id == artist_id and r.user_id == user_id and r.won
        )

    def count_losses(self, artist_id: str, user_id: str) -> int:
        """Count total losses (participated but didn't win)."""
        return sum(
            1 for r in self._records
            if r.artist_id == artist_id
            and r.user_id == user_id
            and r.participated
            and not r.won
        )

    def count_consecutive_losses(self, artist_id: str, user_id: str) -> int:
        """Count consecutive losses from the most recent session backwards."""
        records = self.get_user_history(artist_id, user_id)
        records.sort(key=lambda r: r.session_number, reverse=True)

        consecutive = 0
        for r in records:
            if r.participated and not r.won:
                consecutive += 1
            else:
                break
        return consecutive


def compute_loser_bonus(
    history: SessionHistory,
    user_id: str,
    artist_id: str,
    bonus_per_loss: float = 0.05,
    max_bonus: float = 0.20,
) -> float:
    """
    Compute weight bonus for previous session losers.

    bonus = min(max_bonus, consecutive_losses × bonus_per_loss)

    Args:
        history: Session history store
        user_id: User to compute bonus for
        artist_id: Artist context
        bonus_per_loss: Weight bonus per consecutive loss
        max_bonus: Maximum total bonus

    Returns:
        Weight bonus to add to fan_weight
    """
    consecutive = history.count_consecutive_losses(artist_id, user_id)
    return min(max_bonus, consecutive * bonus_per_loss)


def check_multi_session_limit(
    history: SessionHistory,
    user_id: str,
    artist_id: str,
    max_wins: int = 2,
) -> tuple[bool, str]:
    """
    Check if user has exceeded multi-session win limit.

    Returns:
        (eligible, reason)
    """
    wins = history.count_wins(artist_id, user_id)
    if wins >= max_wins:
        return False, f"Maximum {max_wins} session wins reached ({wins} wins)"
    return True, "Eligible"


def apply_cross_session_adjustments(
    user_weights: dict[str, float],
    history: SessionHistory,
    artist_id: str,
    max_wins: int = 2,
    bonus_per_loss: float = 0.05,
    max_bonus: float = 0.20,
) -> tuple[dict[str, float], list[str]]:
    """
    Apply cross-session adjustments to user weights.

    1. Filter out users who exceeded win limit
    2. Add loser bonus to remaining users' weights

    Args:
        user_weights: {user_id: base_fan_weight}
        history: Session history
        artist_id: Artist context
        max_wins: Maximum wins per user
        bonus_per_loss: Weight bonus per loss
        max_bonus: Maximum bonus cap

    Returns:
        (adjusted_weights, filtered_user_ids)
        filtered_user_ids = users removed due to win limit
    """
    adjusted: dict[str, float] = {}
    filtered: list[str] = []

    for user_id, base_weight in user_weights.items():
        eligible, _ = check_multi_session_limit(
            history, user_id, artist_id, max_wins
        )
        if not eligible:
            filtered.append(user_id)
            continue

        bonus = compute_loser_bonus(
            history, user_id, artist_id, bonus_per_loss, max_bonus
        )
        adjusted[user_id] = base_weight + bonus

    return adjusted, filtered
