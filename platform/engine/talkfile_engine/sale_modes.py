"""
Pickket Sale Modes & Data Models
==================================
Orchestration layer data models for fair ticket sales.

3 sale modes:
  - FIXED_FCFS: Fixed-price first-come-first-served (선착순)
  - POINT_LOTTERY: AP-invested VCG allocation (AP 공정배분)
  - FANCLUB_PRESALE: Community priority at fixed price (커뮤니티 선판매)

Regulatory compliance:
  - 암표3법 (2026.01.29): price cap, identity verification
  - 소비자보호법: transparency reports, fair pricing
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class SaleMode(Enum):
    FIXED_FCFS = "fixed_fcfs"
    POINT_LOTTERY = "point_lottery"
    FANCLUB_PRESALE = "fanclub_presale"


class SalePhase(Enum):
    SETUP = "setup"
    FANCLUB_PRESALE = "fanclub_presale"
    PRIMARY_SALE = "primary_sale"
    REMAINDER_SALE = "remainder_sale"
    CLOSED = "closed"


# Valid phase transitions
VALID_PHASE_TRANSITIONS: dict[SalePhase, list[SalePhase]] = {
    SalePhase.SETUP: [SalePhase.FANCLUB_PRESALE, SalePhase.PRIMARY_SALE],
    SalePhase.FANCLUB_PRESALE: [SalePhase.PRIMARY_SALE],
    SalePhase.PRIMARY_SALE: [SalePhase.REMAINDER_SALE, SalePhase.CLOSED],
    SalePhase.REMAINDER_SALE: [SalePhase.CLOSED],
    SalePhase.CLOSED: [],
}


@dataclass
class SeatTierConfig:
    """Configuration for a single seat tier within an event."""
    tier_id: str
    tier_name: str
    total_seats: int
    face_price: float
    sale_mode: SaleMode
    # VCG-specific
    min_price: float = 0.0
    max_price_cap: float = 0.0
    pool_ratios: dict | None = None
    # Dutch-specific
    dutch_start_price: float = 0.0
    dutch_floor_price: float = 0.0
    dutch_step_amount: float = 0.0
    dutch_step_interval_minutes: int = 0
    # Lottery-specific
    lottery_application_hours: int = 48
    # Fanclub-specific
    fanclub_discount_pct: float = 0.0
    # Group tickets
    allow_group_tickets: bool = True
    max_group_size: int = 4

    def validate(self) -> None:
        """Validate tier configuration."""
        if not self.tier_id or not isinstance(self.tier_id, str):
            raise ValueError("tier_id must be a non-empty string")
        if not self.tier_name or not isinstance(self.tier_name, str):
            raise ValueError("tier_name must be a non-empty string")
        if self.total_seats <= 0:
            raise ValueError(f"total_seats must be positive, got {self.total_seats}")
        if self.face_price < 0:
            raise ValueError(f"face_price must be non-negative, got {self.face_price}")
        if not isinstance(self.sale_mode, SaleMode):
            raise ValueError(f"sale_mode must be SaleMode enum, got {self.sale_mode}")

        if self.sale_mode == SaleMode.POINT_LOTTERY:
            self._validate_lottery()
        elif self.sale_mode == SaleMode.FANCLUB_PRESALE:
            self._validate_fanclub()

        if self.max_group_size < 1 or self.max_group_size > 10:
            raise ValueError(f"max_group_size must be in [1, 10], got {self.max_group_size}")

    def _validate_lottery(self) -> None:
        if self.lottery_application_hours < 1 or self.lottery_application_hours > 168:
            raise ValueError(
                f"lottery_application_hours must be in [1, 168], got {self.lottery_application_hours}"
            )

    def _validate_fanclub(self) -> None:
        if self.fanclub_discount_pct < 0 or self.fanclub_discount_pct > 100:
            raise ValueError(
                f"fanclub_discount_pct must be in [0, 100], got {self.fanclub_discount_pct}"
            )


@dataclass
class PhaseConfig:
    """Configuration for a single sale phase."""
    phase: SalePhase
    starts_at: datetime
    ends_at: datetime
    applicable_tiers: list[str] = field(default_factory=list)

    def validate(self) -> None:
        if self.starts_at >= self.ends_at:
            raise ValueError(
                f"Phase {self.phase.value}: starts_at must be before ends_at"
            )
        if not isinstance(self.phase, SalePhase):
            raise ValueError(f"phase must be SalePhase enum, got {self.phase}")


@dataclass
class RemainderPolicy:
    """Policy for handling unsold seats."""
    strategy: str = "discount_fcfs"
    trigger_hours_before_event: int = 72
    dutch_start_discount_pct: float = 0.0
    dutch_floor_discount_pct: float = 50.0
    dutch_step_pct: float = 5.0
    dutch_step_interval_minutes: int = 60

    def validate(self) -> None:
        if self.strategy not in ("discount_fcfs", "bundle"):
            raise ValueError(f"Unknown strategy: {self.strategy}")
        if self.trigger_hours_before_event < 1:
            raise ValueError("trigger_hours_before_event must be >= 1")
        if self.dutch_floor_discount_pct < 0 or self.dutch_floor_discount_pct > 100:
            raise ValueError("dutch_floor_discount_pct must be in [0, 100]")
        if self.dutch_step_pct <= 0:
            raise ValueError("dutch_step_pct must be > 0")
        if self.dutch_step_interval_minutes <= 0:
            raise ValueError("dutch_step_interval_minutes must be > 0")


@dataclass
class MultiSessionPolicy:
    """Policy for multi-session (tour) events."""
    max_wins_per_user: int = 2
    loser_bonus_weight: float = 0.05
    cross_session_dedup: bool = True

    def validate(self) -> None:
        if self.max_wins_per_user < 1:
            raise ValueError("max_wins_per_user must be >= 1")
        if self.loser_bonus_weight < 0 or self.loser_bonus_weight > 0.5:
            raise ValueError("loser_bonus_weight must be in [0, 0.5]")


@dataclass
class OrchestrationPlan:
    """Complete orchestration plan for an event."""
    event_id: str
    event_name: str
    artist_id: str
    venue_name: str
    event_date: datetime
    tiers: list[SeatTierConfig]
    phases: list[PhaseConfig]
    remainder_policy: RemainderPolicy
    session_number: int = 1
    price_cap_multiplier: float = 2.0
    require_identity_verification: bool = True
    multi_session_policy: MultiSessionPolicy | None = None

    def validate(self) -> None:
        """Validate complete orchestration plan."""
        if not self.event_id:
            raise ValueError("event_id is required")
        if not self.event_name:
            raise ValueError("event_name is required")
        if not self.artist_id:
            raise ValueError("artist_id is required")
        if not self.tiers:
            raise ValueError("At least one tier is required")
        if not self.phases:
            raise ValueError("At least one phase is required")
        if self.price_cap_multiplier < 1.0:
            raise ValueError("price_cap_multiplier must be >= 1.0")

        # Validate each tier
        tier_ids = set()
        for tier in self.tiers:
            tier.validate()
            if tier.tier_id in tier_ids:
                raise ValueError(f"Duplicate tier_id: {tier.tier_id}")
            tier_ids.add(tier.tier_id)

        # Validate phases are in chronological order
        for i, phase in enumerate(self.phases):
            phase.validate()
            if i > 0 and phase.starts_at < self.phases[i - 1].starts_at:
                raise ValueError("Phases must be in chronological order")

        # Validate tier references in phases
        for phase in self.phases:
            for tid in phase.applicable_tiers:
                if tid not in tier_ids:
                    raise ValueError(f"Phase references unknown tier_id: {tid}")

        self.remainder_policy.validate()
        if self.multi_session_policy:
            self.multi_session_policy.validate()


@dataclass
class PurchaseRequest:
    """Request to purchase or bid on tickets."""
    user_id: str
    tier_id: str
    quantity: int = 1
    group_id: str | None = None
    bid_amount: float | None = None
    fan_weight: float = 1.0

    def validate(self) -> None:
        if not self.user_id:
            raise ValueError("user_id is required")
        if not self.tier_id:
            raise ValueError("tier_id is required")
        if self.quantity < 1:
            raise ValueError(f"quantity must be >= 1, got {self.quantity}")
        if self.quantity > 10:
            raise ValueError(f"quantity must be <= 10, got {self.quantity}")
        if self.bid_amount is not None and self.bid_amount < 0:
            raise ValueError(f"bid_amount must be non-negative, got {self.bid_amount}")
        if self.fan_weight <= 0:
            raise ValueError(f"fan_weight must be positive, got {self.fan_weight}")


@dataclass
class PurchaseResult:
    """Result of a purchase or bid attempt."""
    success: bool
    user_id: str
    tier_id: str
    sale_mode: SaleMode
    price_per_seat: float = 0.0
    total_price: float = 0.0
    seat_ids: list[str] = field(default_factory=list)
    waitlist_position: int | None = None
    explanation: str = ""
    audit_id: str = ""
