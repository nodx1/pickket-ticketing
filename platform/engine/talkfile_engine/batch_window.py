"""
TalkFile Batch Auction Window (Axis 1)
=======================================
Manages sealed-bid batch auction windows with randomized close.

Mathematical foundation:
  Budish, Cramton, Shim (2015, QJE): Discrete-time batch auctions eliminate
  the speed arms race of continuous markets.

Key design:
  - All bids within the window are treated as simultaneous arrivals
  - Randomized close (±30 min) prevents sniping
  - Sealed-bid: no bid information leaked during window
  - Bid amendments allowed until close (only final value used)

State machine:
  DRAFT → BIDDING_OPEN → BIDDING_CLOSING → BIDDING_CLOSED → ALLOCATING → ALLOCATED → COMPLETED

Information disclosure:
  - Total participants: band only (e.g., "high competition")
  - Others' bids: never disclosed (sealed bid)
  - Time remaining: shown (with random close range)
  - Price range: min_price ~ max_price (bidding guide)
"""

import math
import random
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum


class AuctionPhase(Enum):
    """Batch auction state machine."""
    DRAFT = "draft"
    BIDDING_OPEN = "bidding_open"
    BIDDING_CLOSING = "bidding_closing"  # Random delay period
    BIDDING_CLOSED = "bidding_closed"
    ALLOCATING = "allocating"
    ALLOCATED = "allocated"
    COMPLETED = "completed"


# Valid phase transitions
VALID_TRANSITIONS: dict[AuctionPhase, list[AuctionPhase]] = {
    AuctionPhase.DRAFT: [AuctionPhase.BIDDING_OPEN],
    AuctionPhase.BIDDING_OPEN: [AuctionPhase.BIDDING_CLOSING],
    AuctionPhase.BIDDING_CLOSING: [AuctionPhase.BIDDING_CLOSED],
    AuctionPhase.BIDDING_CLOSED: [AuctionPhase.ALLOCATING],
    AuctionPhase.ALLOCATING: [AuctionPhase.ALLOCATED],
    AuctionPhase.ALLOCATED: [AuctionPhase.COMPLETED],
    AuctionPhase.COMPLETED: [],
}

# Competition bands for public display
COMPETITION_BANDS = [
    (1.0, "low"),       # ratio < 1.0: fewer bids than seats
    (2.0, "moderate"),  # 1.0 ≤ ratio < 2.0
    (5.0, "high"),      # 2.0 ≤ ratio < 5.0
    (float("inf"), "very_high"),  # ratio ≥ 5.0
]

# Window duration limits
MIN_WINDOW_HOURS = 24
MAX_WINDOW_HOURS = 72
DEFAULT_WINDOW_HOURS = 48

# Randomized close parameters
MAX_RANDOM_DELAY_MINUTES = 30


@dataclass
class BatchWindowConfig:
    """Configuration for a batch auction window."""
    window_hours: int = DEFAULT_WINDOW_HOURS
    max_random_delay_minutes: int = MAX_RANDOM_DELAY_MINUTES
    min_price: float = 0.0
    max_price: float = float("inf")

    def validate(self) -> None:
        if not (MIN_WINDOW_HOURS <= self.window_hours <= MAX_WINDOW_HOURS):
            raise ValueError(
                f"Window hours {self.window_hours} outside [{MIN_WINDOW_HOURS}, {MAX_WINDOW_HOURS}]"
            )
        if self.min_price < 0:
            raise ValueError("min_price cannot be negative")
        if self.max_price < self.min_price:
            raise ValueError("max_price must be >= min_price")


@dataclass
class BatchWindow:
    """Active batch auction window state."""
    event_id: str
    phase: AuctionPhase = AuctionPhase.DRAFT
    config: BatchWindowConfig = None
    opens_at: datetime | None = None
    scheduled_close_at: datetime | None = None
    actual_close_at: datetime | None = None  # After random delay
    random_delay_minutes: float = 0.0
    bid_count: int = 0

    def __post_init__(self):
        if self.config is None:
            self.config = BatchWindowConfig()


def create_window(
    event_id: str,
    opens_at: datetime,
    config: BatchWindowConfig | None = None,
) -> BatchWindow:
    """Create a new batch auction window."""
    if config is None:
        config = BatchWindowConfig()
    config.validate()

    scheduled_close = opens_at + timedelta(hours=config.window_hours)

    return BatchWindow(
        event_id=event_id,
        phase=AuctionPhase.DRAFT,
        config=config,
        opens_at=opens_at,
        scheduled_close_at=scheduled_close,
    )


def transition_phase(window: BatchWindow, new_phase: AuctionPhase) -> BatchWindow:
    """Transition the window to a new phase with validation."""
    valid_next = VALID_TRANSITIONS.get(window.phase, [])
    if new_phase not in valid_next:
        raise ValueError(
            f"Invalid transition: {window.phase.value} → {new_phase.value}. "
            f"Valid: {[p.value for p in valid_next]}"
        )

    window.phase = new_phase

    # Generate random delay when entering BIDDING_CLOSING
    if new_phase == AuctionPhase.BIDDING_CLOSING:
        window.random_delay_minutes = secrets.SystemRandom().uniform(0, window.config.max_random_delay_minutes)
        if window.scheduled_close_at:
            window.actual_close_at = window.scheduled_close_at + timedelta(
                minutes=window.random_delay_minutes
            )

    return window


def can_accept_bid(window: BatchWindow, now: datetime | None = None) -> bool:
    """Check if the window is currently accepting bids."""
    if now is None:
        now = datetime.now(timezone.utc)

    # Accept bids during OPEN and CLOSING phases
    if window.phase not in (AuctionPhase.BIDDING_OPEN, AuctionPhase.BIDDING_CLOSING):
        return False

    # During CLOSING, check if random delay has expired
    if window.phase == AuctionPhase.BIDDING_CLOSING and window.actual_close_at:
        if now >= window.actual_close_at:
            return False

    return True


def should_close(window: BatchWindow, now: datetime | None = None) -> bool:
    """Check if the BIDDING_CLOSING phase should transition to BIDDING_CLOSED."""
    if window.phase != AuctionPhase.BIDDING_CLOSING:
        return False

    if now is None:
        now = datetime.now(timezone.utc)

    if window.actual_close_at and now >= window.actual_close_at:
        return True

    return False


def should_start_closing(window: BatchWindow, now: datetime | None = None) -> bool:
    """Check if BIDDING_OPEN should transition to BIDDING_CLOSING."""
    if window.phase != AuctionPhase.BIDDING_OPEN:
        return False

    if now is None:
        now = datetime.now(timezone.utc)

    if window.scheduled_close_at and now >= window.scheduled_close_at:
        return True

    return False


def get_competition_band(bid_count: int, total_seats: int) -> str:
    """Get competition intensity band for public display (no exact numbers)."""
    if total_seats <= 0:
        return "unknown"

    ratio = bid_count / total_seats
    for threshold, band in COMPETITION_BANDS:
        if ratio < threshold:
            return band

    return "very_high"


def get_public_info(window: BatchWindow, total_seats: int) -> dict:
    """
    Get publicly displayable information about the auction.

    Information disclosure policy (sealed bid):
    - Total participants: band only (not exact count)
    - Others' bids: never disclosed
    - Time remaining: shown with random close range
    - Price range: min/max shown
    """
    info = {
        "event_id": window.event_id,
        "phase": window.phase.value,
        "opens_at": window.opens_at.isoformat() if window.opens_at else None,
        "scheduled_close_at": window.scheduled_close_at.isoformat() if window.scheduled_close_at else None,
        "competition_band": get_competition_band(window.bid_count, total_seats),
        "price_range": {
            "min": window.config.min_price,
            "max": window.config.max_price if window.config.max_price != float("inf") else None,
        },
        "random_close_note": f"Closing time may vary by up to {window.config.max_random_delay_minutes} minutes",
    }

    # Never expose: actual bid count, actual random delay, bid amounts
    return info


def get_competition_signal(bid_count: int, total_seats: int) -> dict:
    """
    Get continuous competition signal for public display (anti-herding).

    Uses sigmoid-based intensity instead of hard thresholds to avoid
    behavioral cliff effects (Banerjee 1992 information cascade model).
    Fuzzy language prevents exact ratio inference.
    """
    if total_seats <= 0:
        return {"intensity": 0.0, "description": "Information not yet available"}

    ratio = bid_count / total_seats
    # Sigmoid: center=1.5, steepness=2. Smooth transition.
    intensity = 1.0 / (1.0 + math.exp(-2.0 * (ratio - 1.5)))

    descriptions = [
        (0.2, "A good number of fans are showing interest"),
        (0.4, "Interest is growing among fans"),
        (0.6, "Many fans are participating"),
        (0.8, "Strong interest from the fan community"),
        (1.0, "Exceptionally high interest from fans"),
    ]
    desc = descriptions[-1][1]
    for threshold, text in descriptions:
        if intensity < threshold:
            desc = text
            break

    return {
        "intensity": round(intensity, 3),
        "description": desc,
    }


@dataclass
class BidAmendmentPolicy:
    """Controls bid amendment behavior within a batch window."""
    max_amendments: int = 3              # Max bid changes allowed
    cooldown_minutes: int = 30           # Minimum time between amendments
    lock_before_close_minutes: int = 60  # Lock amendments before scheduled close


def can_amend_bid(
    window: BatchWindow,
    amendment_count: int,
    last_amendment_at: datetime | None = None,
    now: datetime | None = None,
    policy: BidAmendmentPolicy | None = None,
) -> tuple[bool, str]:
    """
    Check if a bid amendment is allowed under the amendment policy.

    Returns (allowed, reason). Prevents bid ratcheting by limiting
    amendment frequency and count.
    """
    if policy is None:
        policy = BidAmendmentPolicy()

    if now is None:
        now = datetime.now(timezone.utc)

    # Must be in a bid-accepting phase
    if not can_accept_bid(window, now):
        return False, "Bidding window is not accepting bids"

    # Check amendment count limit
    if amendment_count >= policy.max_amendments:
        return False, f"Maximum {policy.max_amendments} amendments reached"

    # Check cooldown
    if last_amendment_at is not None:
        elapsed = (now - last_amendment_at).total_seconds() / 60.0
        if elapsed < policy.cooldown_minutes:
            remaining = policy.cooldown_minutes - elapsed
            return False, f"Please wait {remaining:.0f} minutes before next amendment"

    # Check lock before close
    if window.scheduled_close_at:
        time_to_close = (window.scheduled_close_at - now).total_seconds() / 60.0
        if time_to_close <= policy.lock_before_close_minutes:
            return False, "Amendments are locked close to deadline"

    return True, "Amendment allowed"
