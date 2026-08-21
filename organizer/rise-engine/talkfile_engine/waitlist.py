"""
RISE Waitlist & Reallocation
==============================
Manages waitlists and automatic reallocation on cancellation/non-payment.

Reallocation triggers:
  1. Voluntary cancellation by winner
  2. Payment deadline exceeded (default 30 minutes)
  3. Identity verification failure

Priority order: by priority_score (descending).
Groups: only reallocated if freed_seats >= group_size.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone


@dataclass
class WaitlistEntry:
    """Single waitlist entry."""
    user_id: str
    tier_id: str
    priority_score: float
    group_id: str | None = None
    group_size: int = 1
    entered_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    quantity: int = 1


@dataclass
class ReallocationResult:
    """Result of a single reallocation."""
    user_id: str
    tier_id: str
    seat_ids: list[str] = field(default_factory=list)
    original_winner_id: str = ""
    price: float = 0.0
    notify: bool = True


@dataclass
class PendingPayment:
    """Tracks a pending payment with deadline."""
    user_id: str
    tier_id: str
    seat_ids: list[str]
    price: float
    deadline: datetime
    paid: bool = False


class Waitlist:
    """Priority-ordered waitlist with automatic reallocation."""

    def __init__(self):
        self._entries: dict[str, list[WaitlistEntry]] = {}  # tier_id -> entries
        self._pending_payments: list[PendingPayment] = []

    def add(self, entry: WaitlistEntry) -> int:
        """
        Add entry to waitlist. Returns position (1-based).
        Maintains priority order (highest score first).
        """
        tier_id = entry.tier_id
        if tier_id not in self._entries:
            self._entries[tier_id] = []

        entries = self._entries[tier_id]
        entries.append(entry)
        # Re-sort by priority (descending)
        entries.sort(key=lambda e: (-e.priority_score, e.entered_at))

        # Return position
        for i, e in enumerate(entries):
            if e.user_id == entry.user_id:
                return i + 1
        return len(entries)

    def get_position(self, user_id: str, tier_id: str) -> int | None:
        """Get current waitlist position (1-based). None if not on waitlist."""
        entries = self._entries.get(tier_id, [])
        for i, e in enumerate(entries):
            if e.user_id == user_id:
                return i + 1
        return None

    def get_entries(self, tier_id: str) -> list[WaitlistEntry]:
        """Get all entries for a tier (priority-ordered)."""
        return list(self._entries.get(tier_id, []))

    def size(self, tier_id: str) -> int:
        """Get waitlist size for a tier."""
        return len(self._entries.get(tier_id, []))

    def remove(self, user_id: str, tier_id: str) -> bool:
        """Remove a user from the waitlist. Returns True if found."""
        entries = self._entries.get(tier_id, [])
        for i, e in enumerate(entries):
            if e.user_id == user_id:
                entries.pop(i)
                return True
        return False

    def process_cancellation(
        self,
        tier_id: str,
        freed_seats: int,
        cancelled_by: str = "",
        price: float = 0.0,
    ) -> list[ReallocationResult]:
        """
        Process cancellation and reallocate to waitlist.

        Args:
            tier_id: Tier with freed seats
            freed_seats: Number of seats freed
            cancelled_by: User who cancelled
            price: Price to charge (original winning price)

        Returns:
            List of reallocation results
        """
        if freed_seats <= 0:
            return []

        entries = self._entries.get(tier_id, [])
        if not entries:
            return []

        results: list[ReallocationResult] = []
        remaining = freed_seats
        to_remove: list[int] = []

        for i, entry in enumerate(entries):
            if remaining <= 0:
                break

            needed = entry.group_size if entry.group_id else entry.quantity
            if needed <= remaining:
                results.append(ReallocationResult(
                    user_id=entry.user_id,
                    tier_id=tier_id,
                    original_winner_id=cancelled_by,
                    price=price,
                    notify=True,
                ))
                remaining -= needed
                to_remove.append(i)

        # Remove allocated entries (reverse order to preserve indices)
        for i in reversed(to_remove):
            entries.pop(i)

        return results

    def add_pending_payment(
        self,
        user_id: str,
        tier_id: str,
        seat_ids: list[str],
        price: float,
        deadline_minutes: int = 30,
    ) -> PendingPayment:
        """Add a pending payment with deadline."""
        deadline = datetime.now(timezone.utc) + timedelta(minutes=deadline_minutes)
        pending = PendingPayment(
            user_id=user_id,
            tier_id=tier_id,
            seat_ids=seat_ids,
            price=price,
            deadline=deadline,
        )
        self._pending_payments.append(pending)
        return pending

    def mark_paid(self, user_id: str, tier_id: str) -> bool:
        """Mark a pending payment as paid. Returns True if found."""
        for p in self._pending_payments:
            if p.user_id == user_id and p.tier_id == tier_id and not p.paid:
                p.paid = True
                return True
        return False

    def expire_unpaid(self, now: datetime | None = None) -> list[tuple[str, str, int]]:
        """
        Expire unpaid pending payments past deadline.
        Returns list of (user_id, tier_id, freed_seats) for reallocation.
        """
        if now is None:
            now = datetime.now(timezone.utc)

        expired: list[tuple[str, str, int]] = []
        remaining: list[PendingPayment] = []

        for p in self._pending_payments:
            if not p.paid and now >= p.deadline:
                expired.append((p.user_id, p.tier_id, len(p.seat_ids)))
            else:
                remaining.append(p)

        self._pending_payments = remaining
        return expired
