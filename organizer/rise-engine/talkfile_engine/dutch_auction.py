"""
RISE Dutch Auction Engine
==========================
Descending-price auction for remainder/unsold seats.

Price drops at fixed intervals until floor is reached or all seats sold.
Buyers purchase immediately at the current price.

Formula:
  price(t) = max(floor_price, start_price - steps(t) × step_amount)
  steps(t) = floor((t - started_at) / step_interval)
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone


@dataclass
class DutchPurchase:
    """Record of a Dutch auction purchase."""
    user_id: str
    price: float
    quantity: int
    purchased_at: datetime
    seat_ids: list[str] = field(default_factory=list)


@dataclass
class DutchAuctionState:
    """State of a running Dutch auction."""
    tier_id: str
    start_price: float
    floor_price: float
    step_amount: float
    step_interval_minutes: int
    remaining_seats: int = 0
    started_at: datetime | None = None
    purchases: list[DutchPurchase] = field(default_factory=list)

    def validate(self) -> None:
        if self.start_price <= 0:
            raise ValueError("start_price must be positive")
        if self.floor_price < 0:
            raise ValueError("floor_price must be non-negative")
        if self.floor_price > self.start_price:
            raise ValueError("floor_price must be <= start_price")
        if self.step_amount <= 0:
            raise ValueError("step_amount must be positive")
        if self.step_interval_minutes <= 0:
            raise ValueError("step_interval_minutes must be positive")
        if self.remaining_seats < 0:
            raise ValueError("remaining_seats must be non-negative")


def create_dutch_auction(
    tier_id: str,
    start_price: float,
    floor_price: float,
    step_amount: float,
    step_interval_minutes: int,
    total_seats: int,
    start_at: datetime | None = None,
) -> DutchAuctionState:
    """Create a new Dutch auction."""
    state = DutchAuctionState(
        tier_id=tier_id,
        start_price=start_price,
        floor_price=floor_price,
        step_amount=step_amount,
        step_interval_minutes=step_interval_minutes,
        remaining_seats=total_seats,
        started_at=start_at,
    )
    state.validate()
    return state


def get_current_price(state: DutchAuctionState, now: datetime) -> float:
    """Get the current Dutch auction price at time `now`."""
    if state.started_at is None:
        return state.start_price

    elapsed_seconds = (now - state.started_at).total_seconds()
    if elapsed_seconds < 0:
        return state.start_price

    elapsed_minutes = elapsed_seconds / 60.0
    steps = int(elapsed_minutes / state.step_interval_minutes)
    price = state.start_price - (steps * state.step_amount)
    return max(price, state.floor_price)


def get_current_step(state: DutchAuctionState, now: datetime) -> int:
    """Get the current step number."""
    if state.started_at is None:
        return 0
    elapsed_seconds = (now - state.started_at).total_seconds()
    if elapsed_seconds < 0:
        return 0
    elapsed_minutes = elapsed_seconds / 60.0
    return int(elapsed_minutes / state.step_interval_minutes)


def attempt_purchase(
    state: DutchAuctionState,
    user_id: str,
    quantity: int,
    now: datetime,
) -> DutchPurchase | None:
    """
    Attempt to purchase seats at the current Dutch price.
    Returns DutchPurchase if successful, None if not enough seats.
    Mutates state (reduces remaining_seats, appends purchase).
    """
    if quantity <= 0:
        return None
    if state.remaining_seats < quantity:
        return None
    if state.started_at is None:
        return None

    price = get_current_price(state, now)

    purchase = DutchPurchase(
        user_id=user_id,
        price=price,
        quantity=quantity,
        purchased_at=now,
    )

    state.remaining_seats -= quantity
    state.purchases.append(purchase)
    return purchase


def get_price_schedule(state: DutchAuctionState) -> list[tuple[datetime, float]]:
    """
    Get the full price drop schedule.
    Returns list of (time, price) tuples from start to floor.
    """
    if state.started_at is None:
        return []

    schedule: list[tuple[datetime, float]] = []
    price = state.start_price
    step = 0

    while price > state.floor_price:
        t = state.started_at + timedelta(minutes=step * state.step_interval_minutes)
        schedule.append((t, price))
        step += 1
        price = state.start_price - (step * state.step_amount)

    # Add floor price entry
    t = state.started_at + timedelta(minutes=step * state.step_interval_minutes)
    schedule.append((t, state.floor_price))

    return schedule


def is_active(state: DutchAuctionState, now: datetime) -> bool:
    """Check if the Dutch auction is currently active."""
    if state.started_at is None:
        return False
    if now < state.started_at:
        return False
    if state.remaining_seats <= 0:
        return False
    return True
