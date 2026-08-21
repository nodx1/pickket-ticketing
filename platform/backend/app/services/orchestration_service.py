"""
Orchestration Service
======================
Manages sale phases, phase transitions, and routes purchases
to the appropriate sale mode service.
"""

import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from talkfile_engine.sale_modes import (
    OrchestrationPlan,
    RemainderPolicy,
    SaleMode,
    SalePhase,
    SeatTierConfig,
    VALID_PHASE_TRANSITIONS,
)
from talkfile_engine.orchestrator import PhaseScheduler
from talkfile_engine.sale_modes import PhaseConfig as EnginePhaseConfig

from app.models.event import Event
from app.models.phase_config import PhaseConfig
from app.core.audit import write_audit_log
from app.repositories.event_repo import EventRepository, SeatTierRepository


class OrchestrationService:
    """Service for managing sale phases and routing purchases."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.event_repo = EventRepository(session)
        self.tier_repo = SeatTierRepository(session)

    async def get_current_phase(self, event_id: uuid.UUID) -> str:
        """
        Determine the current phase for an event based on time.

        Checks phase_configs table for which phase is active now.
        Falls back to event.current_phase if no matching config found.

        Args:
            event_id: Event UUID.

        Returns:
            Current phase string (e.g., "setup", "primary_sale", "closed").
        """
        now = datetime.now(timezone.utc)

        # Check phase configs ordered by sort_order
        result = await self.session.execute(
            select(PhaseConfig)
            .where(PhaseConfig.event_id == event_id)
            .order_by(PhaseConfig.sort_order.asc())
        )
        phases = list(result.scalars().all())

        if not phases:
            # Fallback to event.current_phase
            event = await self.event_repo.get(event_id)
            return event.current_phase if event else "setup"

        # Find the phase whose time window contains 'now'
        for phase in phases:
            if phase.starts_at <= now <= phase.ends_at:
                return phase.phase

        # If past all phases, check if we're after the last one
        last_phase = phases[-1]
        if now > last_phase.ends_at:
            return "closed"

        # If before first phase
        first_phase = phases[0]
        if now < first_phase.starts_at:
            return "setup"

        # Between phases (gap) — return the phase that most recently ended
        for i in range(len(phases) - 1, -1, -1):
            if now > phases[i].ends_at:
                return phases[i].phase

        return "setup"

    async def transition_phase(self, event_id: uuid.UUID, new_phase: str) -> None:
        """
        Manually transition an event to a new phase.

        Validates that the transition is allowed according to
        VALID_PHASE_TRANSITIONS from the engine.

        Args:
            event_id: Event UUID.
            new_phase: Target phase string.

        Raises:
            ValueError: If event not found or transition is invalid.
        """
        event = await self.event_repo.get(event_id)
        if not event:
            raise ValueError(f"Event {event_id} not found")

        current = event.current_phase

        # Validate transition
        try:
            current_enum = SalePhase(current)
            new_enum = SalePhase(new_phase)
        except ValueError:
            raise ValueError(f"Invalid phase: {new_phase}")

        valid_next = VALID_PHASE_TRANSITIONS.get(current_enum, [])
        if new_enum not in valid_next:
            valid_names = [p.value for p in valid_next]
            raise ValueError(
                f"Cannot transition from '{current}' to '{new_phase}'. "
                f"Valid transitions: {valid_names}"
            )

        # Update event
        event.current_phase = new_phase

        # Audit
        await write_audit_log(
            self.session,
            action="phase_transition",
            resource_type="event",
            resource_id=str(event_id),
            event_id=event_id,
            new_value={
                "from_phase": current,
                "to_phase": new_phase,
                "result": "success",
            },
        )

    async def setup_phases(self, event_id: uuid.UUID, phases: list[dict]) -> list[PhaseConfig]:
        """
        Create phase configuration entries for an event.

        Args:
            event_id: Event UUID.
            phases: List of dicts with keys:
                - phase: str (e.g., "fanclub_presale")
                - starts_at: datetime
                - ends_at: datetime
                - applicable_tier_ids: list[str] (optional)

        Returns:
            List of created PhaseConfig models.

        Raises:
            ValueError: If event not found.
        """
        event = await self.event_repo.get(event_id)
        if not event:
            raise ValueError(f"Event {event_id} not found")

        created_phases = []
        for i, phase_data in enumerate(phases):
            # Serialize tier IDs as JSON string for SQLite compatibility
            tier_ids = phase_data.get("applicable_tier_ids", [])
            tier_ids_json = json.dumps(tier_ids) if tier_ids else None

            phase_config = PhaseConfig(
                event_id=event_id,
                phase=phase_data["phase"],
                starts_at=phase_data["starts_at"],
                ends_at=phase_data["ends_at"],
                applicable_tier_ids=tier_ids_json,
                sort_order=i,
            )
            self.session.add(phase_config)
            created_phases.append(phase_config)

        await self.session.flush()
        return created_phases

    async def route_purchase(
        self,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
        user_id: uuid.UUID,
        quantity: int,
    ) -> dict:
        """
        Route a purchase to the appropriate service based on tier's sale_mode.

        This method determines the correct sale mode and returns routing info.
        The actual purchase execution should happen at the router level using
        the returned routing info to call the appropriate service.

        Args:
            event_id: Event UUID.
            tier_id: Seat tier UUID.
            user_id: User's UUID.
            quantity: Requested ticket count.

        Returns:
            Dict with routing information:
            - sale_mode: str
            - service: str (service class name to use)
            - method: str (method name to call)
            - tier_id: UUID
            - phase: str

        Raises:
            ValueError: If event or tier not found, or purchase not allowed in current phase.
        """
        event = await self.event_repo.get(event_id)
        if not event:
            raise ValueError(f"Event {event_id} not found")

        tier = await self.tier_repo.get(tier_id)
        if not tier:
            raise ValueError(f"Tier {tier_id} not found")

        current_phase = await self.get_current_phase(event_id)

        # Check if the phase allows this tier
        phase_configs = await self.session.execute(
            select(PhaseConfig).where(
                PhaseConfig.event_id == event_id,
                PhaseConfig.phase == current_phase,
            )
        )
        phase_config = phase_configs.scalar_one_or_none()

        if phase_config and phase_config.applicable_tier_ids:
            try:
                applicable_tiers = json.loads(phase_config.applicable_tier_ids)
                if applicable_tiers and str(tier_id) not in applicable_tiers:
                    raise ValueError(
                        f"Tier {tier_id} is not available in current phase '{current_phase}'"
                    )
            except json.JSONDecodeError:
                pass

        # Validate phase allows purchases
        if current_phase in ("setup", "closed"):
            raise ValueError(f"Purchases not allowed in phase '{current_phase}'")

        # Route based on sale_mode
        sale_mode = tier.sale_mode
        route_map = {
            "fixed_fcfs": {
                "sale_mode": "fixed_fcfs",
                "service": "PurchaseService",
                "method": "purchase_fcfs",
            },
            "fanclub_presale": {
                "sale_mode": "fanclub_presale",
                "service": "PurchaseService",
                "method": "purchase_fanclub",
            },
            "point_lottery": {
                "sale_mode": "point_lottery",
                "service": "LotteryService",
                "method": "apply",
            },
        }

        route = route_map.get(sale_mode)
        if not route:
            raise ValueError(f"Unknown sale mode: {sale_mode}")

        # Validate phase-mode compatibility
        if current_phase == "fanclub_presale" and sale_mode != "fanclub_presale":
            raise ValueError(f"Only fanclub presale purchases allowed in phase '{current_phase}'")

        return {
            **route,
            "tier_id": tier_id,
            "event_id": event_id,
            "user_id": user_id,
            "quantity": quantity,
            "phase": current_phase,
        }

    async def get_phase_schedule(self, event_id: uuid.UUID) -> list[dict]:
        """
        Get the full phase schedule for an event.

        Args:
            event_id: Event UUID.

        Returns:
            List of phase config dicts with current status.
        """
        now = datetime.now(timezone.utc)

        result = await self.session.execute(
            select(PhaseConfig)
            .where(PhaseConfig.event_id == event_id)
            .order_by(PhaseConfig.sort_order.asc())
        )
        phases = list(result.scalars().all())

        schedule = []
        for phase in phases:
            if now < phase.starts_at:
                status = "upcoming"
            elif now > phase.ends_at:
                status = "completed"
            else:
                status = "active"

            tier_ids = []
            if phase.applicable_tier_ids:
                try:
                    tier_ids = json.loads(phase.applicable_tier_ids)
                except json.JSONDecodeError:
                    pass

            schedule.append(
                {
                    "id": phase.id,
                    "phase": phase.phase,
                    "starts_at": phase.starts_at.isoformat(),
                    "ends_at": phase.ends_at.isoformat(),
                    "applicable_tier_ids": tier_ids,
                    "status": status,
                }
            )

        return schedule

    async def _build_orchestration_plan(self, event: Event) -> OrchestrationPlan:
        """
        Build an engine OrchestrationPlan from DB event and phase configs.
        """
        tiers = await self.tier_repo.get_by_event(event.id)

        # Map DB sale_mode strings to engine SaleMode enums
        sale_mode_map = {
            "fixed_fcfs": SaleMode.FIXED_FCFS,
            "point_lottery": SaleMode.POINT_LOTTERY,
            "fanclub_presale": SaleMode.FANCLUB_PRESALE,
            # 'queue' is a FCFS-gating mechanism; engine treats it as fixed FCFS.
            "queue": SaleMode.FIXED_FCFS,
        }

        engine_tiers = []
        for tier in tiers:
            engine_tiers.append(
                SeatTierConfig(
                    tier_id=str(tier.id),
                    tier_name=tier.name,
                    total_seats=tier.capacity,
                    face_price=tier.face_price,
                    sale_mode=sale_mode_map.get(tier.sale_mode, SaleMode.FIXED_FCFS),
                    min_price=tier.min_price,
                    max_price_cap=tier.max_price_cap,
                    fanclub_discount_pct=tier.fanclub_discount_pct,
                    allow_group_tickets=tier.allow_group_tickets,
                    max_group_size=tier.max_group_size,
                )
            )

        # Load phase configs from DB
        result = await self.session.execute(
            select(PhaseConfig)
            .where(PhaseConfig.event_id == event.id)
            .order_by(PhaseConfig.sort_order.asc())
        )
        db_phases = list(result.scalars().all())

        phase_map = {
            "setup": SalePhase.SETUP,
            "fanclub_presale": SalePhase.FANCLUB_PRESALE,
            "primary_sale": SalePhase.PRIMARY_SALE,
            "remainder_sale": SalePhase.REMAINDER_SALE,
            "closed": SalePhase.CLOSED,
        }

        engine_phases = []
        for p in db_phases:
            tier_ids = []
            if p.applicable_tier_ids:
                try:
                    tier_ids = json.loads(p.applicable_tier_ids)
                except json.JSONDecodeError:
                    pass

            engine_phases.append(
                EnginePhaseConfig(
                    phase=phase_map.get(p.phase, SalePhase.SETUP),
                    starts_at=p.starts_at,
                    ends_at=p.ends_at,
                    applicable_tiers=tier_ids,
                )
            )

        remainder_policy = RemainderPolicy(
            strategy=event.remainder_strategy,
            trigger_hours_before_event=event.remainder_trigger_hours,
            dutch_step_interval_minutes=event.remainder_step_interval_min,
        )

        return OrchestrationPlan(
            event_id=str(event.id),
            event_name=event.title,
            artist_id=str(event.artist_id) if event.artist_id else "",
            venue_name=event.venue,
            event_date=event.event_date,
            tiers=engine_tiers,
            phases=engine_phases,
            remainder_policy=remainder_policy,
            session_number=event.session_number,
            price_cap_multiplier=event.price_cap_multiplier,
            require_identity_verification=event.require_identity_verification,
        )

    async def get_active_tiers(self, event_id: uuid.UUID) -> list[dict]:
        """
        Get tiers that are currently active in the current phase.

        Uses engine PhaseScheduler.get_active_tiers() to determine
        which tiers are within their active phase window.

        Args:
            event_id: Event UUID.

        Returns:
            List of dicts with tier_id, tier_name, sale_mode, total_seats.

        Raises:
            ValueError: If event not found.
        """
        event = await self.event_repo.get(event_id)
        if not event:
            raise ValueError(f"Event {event_id} not found")

        plan = await self._build_orchestration_plan(event)
        scheduler = PhaseScheduler()
        scheduler.initialize(plan)

        now = datetime.now(timezone.utc)
        active_tiers = scheduler.get_active_tiers(plan, now)

        return [
            {
                "tier_id": t.tier_id,
                "tier_name": t.tier_name,
                "sale_mode": t.sale_mode.value,
                "total_seats": t.total_seats,
                "face_price": t.face_price,
            }
            for t in active_tiers
        ]

    async def check_remainder_trigger(self, event_id: uuid.UUID) -> dict:
        """
        Check if remainder sale should be triggered for unsold tiers.

        Uses engine PhaseScheduler.should_trigger_remainder() to check
        if conditions are met, and if so, marks unsold tiers for
        remainder sale (discount FCFS).

        Args:
            event_id: Event UUID.

        Returns:
            Dict with 'triggered' bool and optional 'tiers' list of
            tier_ids marked for remainder sale.

        Raises:
            ValueError: If event not found.
        """
        event = await self.event_repo.get(event_id)
        if not event:
            raise ValueError(f"Event {event_id} not found")

        plan = await self._build_orchestration_plan(event)
        scheduler = PhaseScheduler()
        scheduler.initialize(plan)

        now = datetime.now(timezone.utc)
        tiers = await self.tier_repo.get_by_event(event_id)

        # Build unsold counts
        unsold_counts: dict[str, int] = {}
        for tier in tiers:
            remaining = tier.capacity - tier.sold_count
            if remaining > 0:
                unsold_counts[str(tier.id)] = remaining

        should_trigger = scheduler.should_trigger_remainder(
            plan=plan,
            now=now,
            unsold_counts=unsold_counts,
        )

        result = {"triggered": should_trigger, "tiers": []}

        if should_trigger:
            # Mark unsold tiers for remainder sale (discount FCFS)
            triggered_tiers = []
            for tier in tiers:
                remaining = tier.capacity - tier.sold_count
                if remaining > 0:
                    triggered_tiers.append(str(tier.id))

            result["tiers"] = triggered_tiers

            # Audit
            await write_audit_log(
                self.session,
                action="remainder_sale_triggered",
                resource_type="event",
                resource_id=str(event_id),
                event_id=event_id,
                sale_mode="discount_fcfs",
                new_value={
                    "unsold_counts": unsold_counts,
                    "triggered_tiers": triggered_tiers,
                    "result": "success",
                },
            )

        return result
