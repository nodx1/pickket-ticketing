"""
Pickket Orchestrator
=====================
Top-level orchestration: PhaseScheduler + ModeRouter.

Ties together all modules:
  sale_modes → lottery → seat_assigner
  → group_tickets → waitlist → notifications → audit_log

Flow:
  1. OrchestrationPlan created by organizer
  2. PhaseScheduler manages phase transitions
  3. ModeRouter routes requests to appropriate handler
  4. All operations logged via AuditLog
"""

from dataclasses import dataclass
from datetime import datetime, timezone

from talkfile_engine.sale_modes import (
    OrchestrationPlan,
    PurchaseRequest,
    PurchaseResult,
    SaleMode,
    SalePhase,
    SeatTierConfig,
    VALID_PHASE_TRANSITIONS,
)
from talkfile_engine.audit_log import AuditLog
from talkfile_engine.lottery import LotteryEntry, LotteryPool, run_lottery
from talkfile_engine.waitlist import Waitlist, WaitlistEntry
from talkfile_engine.notifications import NotificationService, NotificationType, Notification


class PhaseScheduler:
    """Manages sale phase transitions for an event."""

    def __init__(self):
        self._current_phases: dict[str, SalePhase] = {}  # event_id -> phase

    def initialize(self, plan: OrchestrationPlan) -> None:
        """Initialize scheduler for an event."""
        self._current_phases[plan.event_id] = SalePhase.SETUP

    def get_current_phase(self, event_id: str) -> SalePhase:
        """Get the current phase for an event."""
        return self._current_phases.get(event_id, SalePhase.SETUP)

    def transition(self, event_id: str, new_phase: SalePhase) -> SalePhase:
        """
        Transition to a new phase.
        Validates transition is allowed.
        """
        current = self.get_current_phase(event_id)
        valid_next = VALID_PHASE_TRANSITIONS.get(current, [])
        if new_phase not in valid_next:
            raise ValueError(
                f"Invalid transition: {current.value} → {new_phase.value}. "
                f"Valid: {[p.value for p in valid_next]}"
            )
        self._current_phases[event_id] = new_phase
        return new_phase

    def get_active_tiers(
        self, plan: OrchestrationPlan, now: datetime
    ) -> list[SeatTierConfig]:
        """Get tiers that are currently active (within their phase window)."""
        active: list[SeatTierConfig] = []
        tier_map = {t.tier_id: t for t in plan.tiers}

        for phase_config in plan.phases:
            if phase_config.starts_at <= now <= phase_config.ends_at:
                for tier_id in phase_config.applicable_tiers:
                    if tier_id in tier_map:
                        active.append(tier_map[tier_id])

        return active

    def should_trigger_remainder(
        self,
        plan: OrchestrationPlan,
        now: datetime,
        unsold_counts: dict[str, int],
    ) -> bool:
        """Check if remainder sale should be triggered."""
        from datetime import timedelta
        trigger_time = plan.event_date - timedelta(
            hours=plan.remainder_policy.trigger_hours_before_event
        )
        if now < trigger_time:
            return False

        # Only trigger if there are unsold seats
        total_unsold = sum(unsold_counts.values())
        return total_unsold > 0


class ModeRouter:
    """Routes purchase requests to the appropriate handler based on sale mode."""

    def __init__(
        self,
        audit_log: AuditLog,
        waitlist: Waitlist,
        notifications: NotificationService,
    ):
        self.audit = audit_log
        self.waitlist = waitlist
        self.notifications = notifications
        # Mode-specific state
        self._fcfs_sold: dict[str, int] = {}  # tier_id -> sold count
        self._lottery_pools: dict[str, LotteryPool] = {}  # tier_id -> pool
        self._tier_configs: dict[str, SeatTierConfig] = {}
        self._event_id: str = ""

    @property
    def initialized(self) -> bool:
        """Whether the router has been initialized."""
        return bool(self._event_id)

    def initialize(self, plan: OrchestrationPlan) -> None:
        """Initialize router with event plan. Raises if already initialized."""
        if self._event_id:
            raise ValueError(
                f"Router already initialized for event {self._event_id}. "
                "Create a new ModeRouter for a different event."
            )
        self._event_id = plan.event_id
        for tier in plan.tiers:
            self._tier_configs[tier.tier_id] = tier
            self._fcfs_sold[tier.tier_id] = 0

    def get_tier(self, tier_id: str) -> SeatTierConfig | None:
        return self._tier_configs.get(tier_id)

    def get_sold_count(self, tier_id: str) -> int:
        return self._fcfs_sold.get(tier_id, 0)

    def get_remaining(self, tier_id: str) -> int:
        tier = self._tier_configs.get(tier_id)
        if not tier:
            return 0
        return tier.total_seats - self._fcfs_sold.get(tier_id, 0)

    def route(
        self, request: PurchaseRequest, now: datetime | None = None
    ) -> PurchaseResult:
        """Route a purchase request to the appropriate handler."""
        if now is None:
            now = datetime.now(timezone.utc)

        request.validate()
        tier = self._tier_configs.get(request.tier_id)
        if not tier:
            return PurchaseResult(
                success=False,
                user_id=request.user_id,
                tier_id=request.tier_id,
                sale_mode=SaleMode.FIXED_FCFS,
                explanation=f"Unknown tier: {request.tier_id}",
            )

        match tier.sale_mode:
            case SaleMode.FIXED_FCFS:
                result = self._handle_fcfs(tier, request)
            case SaleMode.POINT_LOTTERY:
                result = self._handle_point_lottery_application(tier, request)
            case SaleMode.FANCLUB_PRESALE:
                result = self._handle_fanclub(tier, request)
            case _:
                result = PurchaseResult(
                    success=False,
                    user_id=request.user_id,
                    tier_id=request.tier_id,
                    sale_mode=tier.sale_mode,
                    explanation=f"Unsupported mode: {tier.sale_mode.value}",
                )

        # Audit log
        audit_id = self.audit.log(
            event_id=self._event_id,
            action="purchase" if result.success else "purchase_failed",
            user_id=request.user_id,
            tier_id=request.tier_id,
            sale_mode=tier.sale_mode.value,
            details={
                "price": result.total_price,
                "quantity": request.quantity,
                "seats": result.seat_ids,
            },
            result="success" if result.success else "failed",
        )
        result.audit_id = audit_id
        return result

    def _handle_fcfs(
        self, tier: SeatTierConfig, request: PurchaseRequest
    ) -> PurchaseResult:
        """Handle fixed-price first-come-first-served."""
        sold = self._fcfs_sold.get(tier.tier_id, 0)
        remaining = tier.total_seats - sold

        if request.quantity > remaining:
            return PurchaseResult(
                success=False,
                user_id=request.user_id,
                tier_id=tier.tier_id,
                sale_mode=SaleMode.FIXED_FCFS,
                explanation=f"Only {remaining} seats remaining",
            )

        self._fcfs_sold[tier.tier_id] = sold + request.quantity
        return PurchaseResult(
            success=True,
            user_id=request.user_id,
            tier_id=tier.tier_id,
            sale_mode=SaleMode.FIXED_FCFS,
            price_per_seat=tier.face_price,
            total_price=tier.face_price * request.quantity,
            explanation="Purchase confirmed at face price",
        )

    def _handle_point_lottery_application(
        self, tier: SeatTierConfig, request: PurchaseRequest
    ) -> PurchaseResult:
        """Handle AP point lottery application (VCG allocation happens in batch)."""
        pool = self._lottery_pools.get(tier.tier_id)
        if not pool:
            # Auto-create pool for point_lottery
            pool = LotteryPool(
                tier_id=tier.tier_id,
                total_seats=tier.total_seats,
                use_fan_weight=True,
            )
            self._lottery_pools[tier.tier_id] = pool

        entry = LotteryEntry(
            user_id=request.user_id,
            group_id=request.group_id,
            group_size=request.quantity if request.group_id else 1,
        )
        pool.entries.append(entry)

        return PurchaseResult(
            success=True,
            user_id=request.user_id,
            tier_id=tier.tier_id,
            sale_mode=SaleMode.POINT_LOTTERY,
            price_per_seat=tier.face_price,
            explanation="AP 공정배분 접수 완료. 마감 후 VCG 배분됩니다.",
        )

    def _handle_fanclub(
        self, tier: SeatTierConfig, request: PurchaseRequest
    ) -> PurchaseResult:
        """Handle fanclub presale (fixed price, weight priority for seating)."""
        sold = self._fcfs_sold.get(tier.tier_id, 0)
        remaining = tier.total_seats - sold

        if request.quantity > remaining:
            # Add to waitlist
            self.waitlist.add(WaitlistEntry(
                user_id=request.user_id,
                tier_id=tier.tier_id,
                priority_score=request.fan_weight,
                quantity=request.quantity,
            ))
            position = self.waitlist.get_position(request.user_id, tier.tier_id)
            return PurchaseResult(
                success=False,
                user_id=request.user_id,
                tier_id=tier.tier_id,
                sale_mode=SaleMode.FANCLUB_PRESALE,
                waitlist_position=position,
                explanation=f"Sold out. Waitlist position: #{position}",
            )

        price = tier.face_price * (1 - tier.fanclub_discount_pct / 100.0)
        self._fcfs_sold[tier.tier_id] = sold + request.quantity

        return PurchaseResult(
            success=True,
            user_id=request.user_id,
            tier_id=tier.tier_id,
            sale_mode=SaleMode.FANCLUB_PRESALE,
            price_per_seat=price,
            total_price=price * request.quantity,
            explanation=f"Fanclub presale confirmed ({tier.fanclub_discount_pct}% discount)",
        )

    def run_tier_lottery(
        self, tier_id: str, weights: dict[str, float] | None = None, seed: int | None = None
    ):
        """Run lottery for a tier and return results."""
        pool = self._lottery_pools.get(tier_id)
        if not pool:
            return None
        return run_lottery(pool, weights, seed)

    def process_cancellation_with_notification(
        self,
        tier_id: str,
        freed_seats: int,
        cancelled_by: str = "",
        price: float = 0.0,
        deadline_minutes: int = 30,
    ) -> list:
        """
        Process cancellation, reallocate from waitlist, and auto-notify.
        Returns list of ReallocationResult.
        """
        from talkfile_engine.waitlist import ReallocationResult

        results = self.waitlist.process_cancellation(
            tier_id=tier_id,
            freed_seats=freed_seats,
            cancelled_by=cancelled_by,
            price=price,
        )

        for r in results:
            # Send cancellation offer notification
            self.notifications.notify_cancellation_offer(
                event_id=self._event_id,
                tier_id=tier_id,
                user_id=r.user_id,
                price=r.price,
                deadline_minutes=deadline_minutes,
            )
            # Audit
            self.audit.log(
                event_id=self._event_id,
                action="reallocation",
                user_id=r.user_id,
                tier_id=tier_id,
                sale_mode="waitlist",
                details={
                    "original_winner": cancelled_by,
                    "price": price,
                },
                result="success",
            )

        return results
