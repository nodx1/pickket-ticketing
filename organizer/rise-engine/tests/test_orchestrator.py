"""
PhaseScheduler & ModeRouter Unit Tests
========================================
Tests for the RISE orchestration layer's core scheduling and routing logic.

Covers:
  - PhaseScheduler: initialization, transitions, active tiers, remainder trigger
  - ModeRouter: routing across FIXED_FCFS, POINT_LOTTERY, FANCLUB_PRESALE modes, audit logging, inventory tracking
"""

import pytest
from datetime import datetime, timedelta, timezone

from talkfile_engine.sale_modes import (
    OrchestrationPlan,
    PhaseConfig,
    PurchaseRequest,
    PurchaseResult,
    RemainderPolicy,
    SaleMode,
    SalePhase,
    SeatTierConfig,
    VALID_PHASE_TRANSITIONS,
)
from talkfile_engine.orchestrator import PhaseScheduler, ModeRouter
from talkfile_engine.audit_log import AuditLog
from talkfile_engine.waitlist import Waitlist, WaitlistEntry
from talkfile_engine.notifications import NotificationService


# ---------------------------------------------------------------------------
# Fixtures & helpers
# ---------------------------------------------------------------------------

_BASE_TIME = datetime(2026, 8, 1, 10, 0, 0, tzinfo=timezone.utc)
_EVENT_DATE = datetime(2026, 9, 15, 18, 0, 0, tzinfo=timezone.utc)


def _make_plan(
    event_id: str = "evt-aespa-seoul-2026",
    tiers: list[SeatTierConfig] | None = None,
    phases: list[PhaseConfig] | None = None,
) -> OrchestrationPlan:
    """Build a realistic Korean concert orchestration plan."""
    if tiers is None:
        tiers = [
            SeatTierConfig(
                tier_id="vip",
                tier_name="VIP석",
                total_seats=200,
                face_price=220_000,
                sale_mode=SaleMode.FIXED_FCFS,
            ),
            SeatTierConfig(
                tier_id="r",
                tier_name="R석",
                total_seats=500,
                face_price=154_000,
                sale_mode=SaleMode.POINT_LOTTERY,
                lottery_application_hours=48,
            ),
            SeatTierConfig(
                tier_id="s",
                tier_name="S석",
                total_seats=800,
                face_price=132_000,
                sale_mode=SaleMode.FIXED_FCFS,
            ),
            SeatTierConfig(
                tier_id="a",
                tier_name="A석",
                total_seats=1000,
                face_price=99_000,
                sale_mode=SaleMode.FIXED_FCFS,
            ),
        ]
    if phases is None:
        phases = [
            PhaseConfig(
                phase=SalePhase.FANCLUB_PRESALE,
                starts_at=_BASE_TIME,
                ends_at=_BASE_TIME + timedelta(days=1),
                applicable_tiers=["vip", "r"],
            ),
            PhaseConfig(
                phase=SalePhase.PRIMARY_SALE,
                starts_at=_BASE_TIME + timedelta(days=2),
                ends_at=_BASE_TIME + timedelta(days=9),
                applicable_tiers=["vip", "r", "s", "a"],
            ),
            PhaseConfig(
                phase=SalePhase.REMAINDER_SALE,
                starts_at=_BASE_TIME + timedelta(days=10),
                ends_at=_BASE_TIME + timedelta(days=14),
                applicable_tiers=["s", "a"],
            ),
        ]

    return OrchestrationPlan(
        event_id=event_id,
        event_name="aespa LIVE TOUR 'SYNK' 서울",
        artist_id="artist-aespa",
        venue_name="KSPO DOME",
        event_date=_EVENT_DATE,
        tiers=tiers,
        phases=phases,
        remainder_policy=RemainderPolicy(
            trigger_hours_before_event=72,
            dutch_start_discount_pct=0.0,
            dutch_floor_discount_pct=50.0,
            dutch_step_pct=5.0,
            dutch_step_interval_minutes=60,
        ),
    )


def _make_router() -> tuple[ModeRouter, AuditLog, Waitlist, NotificationService]:
    """Create a ModeRouter and return all collaborators for inspection."""
    audit = AuditLog()
    waitlist = Waitlist()
    notif = NotificationService()
    router = ModeRouter(audit_log=audit, waitlist=waitlist, notifications=notif)
    return router, audit, waitlist, notif


# ===================================================================
# PhaseScheduler tests
# ===================================================================

class TestPhaseSchedulerInit:
    """PhaseScheduler initialization and basic phase queries."""

    def test_initialize_sets_setup_phase(self):
        """After initialize(), current phase should be SETUP."""
        scheduler = PhaseScheduler()
        plan = _make_plan()
        scheduler.initialize(plan)
        assert scheduler.get_current_phase(plan.event_id) == SalePhase.SETUP

    def test_get_current_phase_unknown_event_returns_setup(self):
        """Querying an un-initialized event defaults to SETUP."""
        scheduler = PhaseScheduler()
        assert scheduler.get_current_phase("nonexistent") == SalePhase.SETUP


class TestPhaseSchedulerTransitions:
    """Valid and invalid phase transition logic."""

    def test_setup_to_fanclub_presale(self):
        scheduler = PhaseScheduler()
        plan = _make_plan()
        scheduler.initialize(plan)
        result = scheduler.transition(plan.event_id, SalePhase.FANCLUB_PRESALE)
        assert result == SalePhase.FANCLUB_PRESALE
        assert scheduler.get_current_phase(plan.event_id) == SalePhase.FANCLUB_PRESALE

    def test_setup_to_primary_sale(self):
        """SETUP -> PRIMARY_SALE is valid (skip presale)."""
        scheduler = PhaseScheduler()
        plan = _make_plan()
        scheduler.initialize(plan)
        result = scheduler.transition(plan.event_id, SalePhase.PRIMARY_SALE)
        assert result == SalePhase.PRIMARY_SALE

    def test_primary_to_remainder(self):
        scheduler = PhaseScheduler()
        plan = _make_plan()
        scheduler.initialize(plan)
        scheduler.transition(plan.event_id, SalePhase.PRIMARY_SALE)
        result = scheduler.transition(plan.event_id, SalePhase.REMAINDER_SALE)
        assert result == SalePhase.REMAINDER_SALE

    def test_primary_to_closed(self):
        scheduler = PhaseScheduler()
        plan = _make_plan()
        scheduler.initialize(plan)
        scheduler.transition(plan.event_id, SalePhase.PRIMARY_SALE)
        result = scheduler.transition(plan.event_id, SalePhase.CLOSED)
        assert result == SalePhase.CLOSED

    def test_invalid_transition_raises_value_error(self):
        """SETUP -> REMAINDER is not in VALID_PHASE_TRANSITIONS."""
        scheduler = PhaseScheduler()
        plan = _make_plan()
        scheduler.initialize(plan)
        with pytest.raises(ValueError, match="Invalid transition"):
            scheduler.transition(plan.event_id, SalePhase.REMAINDER_SALE)

    def test_closed_to_anything_raises(self):
        """CLOSED has no valid outgoing transitions."""
        scheduler = PhaseScheduler()
        plan = _make_plan()
        scheduler.initialize(plan)
        scheduler.transition(plan.event_id, SalePhase.PRIMARY_SALE)
        scheduler.transition(plan.event_id, SalePhase.CLOSED)
        with pytest.raises(ValueError, match="Invalid transition"):
            scheduler.transition(plan.event_id, SalePhase.PRIMARY_SALE)


class TestPhaseSchedulerActiveTiers:
    """get_active_tiers() returns tiers whose phase window contains `now`."""

    def test_active_tiers_during_presale(self):
        scheduler = PhaseScheduler()
        plan = _make_plan()
        now = _BASE_TIME + timedelta(hours=6)  # mid-presale
        active = scheduler.get_active_tiers(plan, now)
        active_ids = {t.tier_id for t in active}
        assert active_ids == {"vip", "r"}

    def test_active_tiers_during_primary(self):
        scheduler = PhaseScheduler()
        plan = _make_plan()
        now = _BASE_TIME + timedelta(days=5)  # mid-primary
        active = scheduler.get_active_tiers(plan, now)
        active_ids = {t.tier_id for t in active}
        assert active_ids == {"vip", "r", "s", "a"}

    def test_no_active_tiers_outside_all_windows(self):
        scheduler = PhaseScheduler()
        plan = _make_plan()
        now = _BASE_TIME - timedelta(days=30)  # way before any phase
        active = scheduler.get_active_tiers(plan, now)
        assert active == []


class TestPhaseSchedulerRemainder:
    """should_trigger_remainder() time + unsold check."""

    def test_triggers_when_time_passed_and_unsold_exist(self):
        scheduler = PhaseScheduler()
        plan = _make_plan()
        # 72 hours before event date
        trigger_boundary = _EVENT_DATE - timedelta(hours=72)
        now = trigger_boundary + timedelta(hours=1)
        unsold = {"s": 50, "a": 120}
        assert scheduler.should_trigger_remainder(plan, now, unsold) is True

    def test_does_not_trigger_before_threshold(self):
        scheduler = PhaseScheduler()
        plan = _make_plan()
        now = _EVENT_DATE - timedelta(hours=100)  # too early
        unsold = {"s": 50}
        assert scheduler.should_trigger_remainder(plan, now, unsold) is False

    def test_does_not_trigger_with_zero_unsold(self):
        scheduler = PhaseScheduler()
        plan = _make_plan()
        now = _EVENT_DATE - timedelta(hours=10)
        unsold = {"s": 0, "a": 0}
        assert scheduler.should_trigger_remainder(plan, now, unsold) is False


# ===================================================================
# ModeRouter tests
# ===================================================================

class TestModeRouterFCFS:
    """FIXED_FCFS routing: purchase and sold-out paths."""

    def test_fcfs_purchase_success(self):
        router, audit, _, _ = _make_router()
        plan = _make_plan()
        router.initialize(plan)

        req = PurchaseRequest(user_id="user-1", tier_id="s", quantity=2)
        result = router.route(req)

        assert result.success is True
        assert result.sale_mode == SaleMode.FIXED_FCFS
        assert result.price_per_seat == 132_000
        assert result.total_price == 264_000
        assert "confirmed" in result.explanation.lower()

    def test_fcfs_sold_out(self):
        """Buy all seats, then the next request should fail."""
        router, _, _, _ = _make_router()
        # Single-tier plan with only 3 S seats
        tiny_tier = SeatTierConfig(
            tier_id="s", tier_name="S석", total_seats=3,
            face_price=132_000, sale_mode=SaleMode.FIXED_FCFS,
        )
        plan = _make_plan(tiers=[tiny_tier])
        router.initialize(plan)

        # Buy all 3
        router.route(PurchaseRequest(user_id="u1", tier_id="s", quantity=3))
        # 4th seat should fail
        result = router.route(PurchaseRequest(user_id="u2", tier_id="s", quantity=1))
        assert result.success is False
        assert "remaining" in result.explanation.lower()


class TestModeRouterPointLottery:
    """POINT_LOTTERY routing: application submitted."""

    def test_point_lottery_application_submitted(self):
        router, _, _, _ = _make_router()
        plan = _make_plan()
        router.initialize(plan)

        req = PurchaseRequest(user_id="user-lottery", tier_id="r", quantity=1)
        result = router.route(req)

        assert result.success is True
        assert result.sale_mode == SaleMode.POINT_LOTTERY
        assert "접수" in result.explanation or "공정배분" in result.explanation
        assert result.price_per_seat == 154_000


class TestModeRouterFanclub:
    """FANCLUB_PRESALE routing: discounted purchase and waitlist fallback."""

    def test_fanclub_purchase_with_discount(self):
        router, _, _, _ = _make_router()
        fc_tier = SeatTierConfig(
            tier_id="vip-fc", tier_name="VIP 팬클럽",
            total_seats=50, face_price=220_000,
            sale_mode=SaleMode.FANCLUB_PRESALE,
            fanclub_discount_pct=10.0,
        )
        plan = _make_plan(tiers=[fc_tier])
        router.initialize(plan)

        req = PurchaseRequest(user_id="fan-001", tier_id="vip-fc", quantity=1)
        result = router.route(req)

        expected_price = 220_000 * 0.9  # 198_000
        assert result.success is True
        assert result.sale_mode == SaleMode.FANCLUB_PRESALE
        assert result.price_per_seat == pytest.approx(expected_price)
        assert result.total_price == pytest.approx(expected_price)
        assert "10.0%" in result.explanation

    def test_fanclub_sold_out_adds_to_waitlist(self):
        router, _, waitlist, _ = _make_router()
        fc_tier = SeatTierConfig(
            tier_id="vip-fc", tier_name="VIP 팬클럽",
            total_seats=1, face_price=220_000,
            sale_mode=SaleMode.FANCLUB_PRESALE,
            fanclub_discount_pct=10.0,
        )
        plan = _make_plan(tiers=[fc_tier])
        router.initialize(plan)

        # Buy the only seat
        router.route(PurchaseRequest(user_id="fan-winner", tier_id="vip-fc", quantity=1))
        # Next fan gets waitlisted
        result = router.route(
            PurchaseRequest(user_id="fan-late", tier_id="vip-fc", quantity=1, fan_weight=1.5)
        )

        assert result.success is False
        assert result.waitlist_position is not None
        assert result.waitlist_position >= 1
        assert waitlist.size("vip-fc") == 1


class TestModeRouterEdgeCases:
    """Unknown tiers, audit logging, remaining inventory."""

    def test_unknown_tier_returns_error(self):
        router, _, _, _ = _make_router()
        plan = _make_plan()
        router.initialize(plan)

        req = PurchaseRequest(user_id="u-x", tier_id="nonexistent", quantity=1)
        result = router.route(req)

        assert result.success is False
        assert "unknown tier" in result.explanation.lower()

    def test_audit_log_created_for_each_route_call(self):
        """Every call to route() should produce an AuditEntry."""
        router, audit, _, _ = _make_router()
        plan = _make_plan()
        router.initialize(plan)

        router.route(PurchaseRequest(user_id="u1", tier_id="s", quantity=1))
        router.route(PurchaseRequest(user_id="u2", tier_id="s", quantity=1))
        router.route(PurchaseRequest(user_id="u3", tier_id="a", quantity=2))

        entries = audit.query(event_id=plan.event_id)
        assert len(entries) == 3
        # Each entry should have a non-empty audit_id
        for e in entries:
            assert len(e.audit_id) > 0

    def test_get_remaining_tracks_sold_counts(self):
        router, _, _, _ = _make_router()
        plan = _make_plan()
        router.initialize(plan)

        assert router.get_remaining("s") == 800
        router.route(PurchaseRequest(user_id="u1", tier_id="s", quantity=3))
        assert router.get_remaining("s") == 797
        assert router.get_sold_count("s") == 3
