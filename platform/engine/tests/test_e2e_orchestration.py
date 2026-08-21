"""
End-to-End Orchestration Scenario Tests
==========================================
Full lifecycle tests exercising PhaseScheduler + ModeRouter together
with all supporting modules (audit, waitlist, notifications, lottery).

Scenarios use realistic Korean concert data:
  - Venue: KSPO DOME, Seoul
  - Tiers: VIP석, R석, S석, A석
  - Prices in KRW (face values: 220,000 / 154,000 / 132,000 / 99,000)
"""

import pytest
from datetime import datetime, timedelta, timezone

from talkfile_engine.sale_modes import (
    MultiSessionPolicy,
    OrchestrationPlan,
    PhaseConfig,
    PurchaseRequest,
    RemainderPolicy,
    SaleMode,
    SalePhase,
    SeatTierConfig,
)
from talkfile_engine.orchestrator import PhaseScheduler, ModeRouter
from talkfile_engine.audit_log import AuditLog
from talkfile_engine.waitlist import Waitlist, WaitlistEntry
from talkfile_engine.notifications import NotificationService, NotificationType
from talkfile_engine.multi_session import (
    SessionHistory,
    SessionRecord,
    apply_cross_session_adjustments,
    compute_loser_bonus,
)


# ---------------------------------------------------------------------------
# Shared constants & fixture helpers
# ---------------------------------------------------------------------------

_KST = timezone(timedelta(hours=9))
_PRESALE_START = datetime(2026, 8, 1, 10, 0, 0, tzinfo=_KST)
_PRIMARY_START = datetime(2026, 8, 3, 10, 0, 0, tzinfo=_KST)
_REMAINDER_START = datetime(2026, 9, 12, 10, 0, 0, tzinfo=_KST)
_EVENT_DATE = datetime(2026, 9, 15, 18, 0, 0, tzinfo=_KST)


def _tier_vip_fcfs(seats: int = 200) -> SeatTierConfig:
    return SeatTierConfig(
        tier_id="vip", tier_name="VIP석",
        total_seats=seats, face_price=220_000,
        sale_mode=SaleMode.FIXED_FCFS,
    )


def _tier_r_point_lottery(seats: int = 500) -> SeatTierConfig:
    return SeatTierConfig(
        tier_id="r", tier_name="R석",
        total_seats=seats, face_price=154_000,
        sale_mode=SaleMode.POINT_LOTTERY,
        lottery_application_hours=48,
    )


def _tier_s_fcfs(seats: int = 800) -> SeatTierConfig:
    return SeatTierConfig(
        tier_id="s", tier_name="S석",
        total_seats=seats, face_price=132_000,
        sale_mode=SaleMode.FIXED_FCFS,
    )


def _tier_a_fcfs(seats: int = 1000) -> SeatTierConfig:
    return SeatTierConfig(
        tier_id="a", tier_name="A석",
        total_seats=seats, face_price=99_000,
        sale_mode=SaleMode.FIXED_FCFS,
    )


def _tier_fanclub(seats: int = 50, discount_pct: float = 10.0) -> SeatTierConfig:
    return SeatTierConfig(
        tier_id="fc-vip", tier_name="VIP 팬클럽 선예매",
        total_seats=seats, face_price=220_000,
        sale_mode=SaleMode.FANCLUB_PRESALE,
        fanclub_discount_pct=discount_pct,
    )


def _standard_phases() -> list[PhaseConfig]:
    return [
        PhaseConfig(
            phase=SalePhase.FANCLUB_PRESALE,
            starts_at=_PRESALE_START,
            ends_at=_PRESALE_START + timedelta(days=1),
            applicable_tiers=["fc-vip"],
        ),
        PhaseConfig(
            phase=SalePhase.PRIMARY_SALE,
            starts_at=_PRIMARY_START,
            ends_at=_PRIMARY_START + timedelta(days=7),
            applicable_tiers=["vip", "r", "s", "a"],
        ),
        PhaseConfig(
            phase=SalePhase.REMAINDER_SALE,
            starts_at=_REMAINDER_START,
            ends_at=_REMAINDER_START + timedelta(days=3),
            applicable_tiers=["s", "a"],
        ),
    ]


def _full_plan(
    event_id: str = "evt-aespa-seoul-2026",
    tiers: list[SeatTierConfig] | None = None,
    phases: list[PhaseConfig] | None = None,
) -> OrchestrationPlan:
    if tiers is None:
        tiers = [
            _tier_fanclub(),
            _tier_vip_fcfs(),
            _tier_r_point_lottery(),
            _tier_s_fcfs(),
            _tier_a_fcfs(),
        ]
    if phases is None:
        phases = _standard_phases()
    return OrchestrationPlan(
        event_id=event_id,
        event_name="aespa LIVE TOUR 'SYNK' 서울공연",
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
            dutch_step_interval_minutes=30,
        ),
    )


def _build_system(plan: OrchestrationPlan | None = None):
    """Instantiate and wire together all orchestration components."""
    if plan is None:
        plan = _full_plan()
    audit = AuditLog()
    waitlist = Waitlist()
    notif = NotificationService()
    scheduler = PhaseScheduler()
    router = ModeRouter(audit_log=audit, waitlist=waitlist, notifications=notif)
    scheduler.initialize(plan)
    router.initialize(plan)
    return scheduler, router, audit, waitlist, notif, plan


# ===================================================================
# E2E scenario tests
# ===================================================================

class TestCompleteEventLifecycle:
    """Full lifecycle: SETUP -> fanclub presale -> primary (FCFS + POINT_LOTTERY) -> remainder -> closed."""

    def test_full_lifecycle(self):
        scheduler, router, audit, waitlist, notif, plan = _build_system()

        # --- Phase 1: SETUP -> FANCLUB_PRESALE ---
        scheduler.transition(plan.event_id, SalePhase.FANCLUB_PRESALE)
        assert scheduler.get_current_phase(plan.event_id) == SalePhase.FANCLUB_PRESALE

        # Fanclub purchase
        fc_result = router.route(
            PurchaseRequest(user_id="fan-001", tier_id="fc-vip", quantity=2)
        )
        assert fc_result.success is True
        expected_unit = 220_000 * 0.9
        assert fc_result.price_per_seat == pytest.approx(expected_unit)

        # --- Phase 2: FANCLUB_PRESALE -> PRIMARY_SALE ---
        scheduler.transition(plan.event_id, SalePhase.PRIMARY_SALE)

        # FCFS purchases on VIP, S and A
        vip_result = router.route(
            PurchaseRequest(user_id="buyer-vip1", tier_id="vip", quantity=1)
        )
        assert vip_result.success is True
        assert vip_result.sale_mode == SaleMode.FIXED_FCFS

        s_result = router.route(
            PurchaseRequest(user_id="buyer-s1", tier_id="s", quantity=4)
        )
        assert s_result.success is True
        assert s_result.total_price == 132_000 * 4

        a_result = router.route(
            PurchaseRequest(user_id="buyer-a1", tier_id="a", quantity=2)
        )
        assert a_result.success is True

        # Point lottery application on R
        lottery_result = router.route(
            PurchaseRequest(user_id="applicant-1", tier_id="r", quantity=1)
        )
        assert lottery_result.success is True
        assert lottery_result.sale_mode == SaleMode.POINT_LOTTERY

        # --- Phase 3: PRIMARY_SALE -> REMAINDER_SALE ---
        scheduler.transition(plan.event_id, SalePhase.REMAINDER_SALE)

        # --- Phase 4: REMAINDER_SALE -> CLOSED ---
        scheduler.transition(plan.event_id, SalePhase.CLOSED)
        assert scheduler.get_current_phase(plan.event_id) == SalePhase.CLOSED

        # Verify audit trail covers all operations
        all_entries = audit.query(event_id=plan.event_id)
        assert len(all_entries) >= 5  # at least one per route() call above


class TestMixedModeEvent:
    """Mixed mode event: VIP=FCFS, R=POINT_LOTTERY, S=FCFS, A=FCFS -- all within primary."""

    def test_all_modes_in_single_primary_phase(self):
        scheduler, router, audit, _, _, plan = _build_system()
        scheduler.transition(plan.event_id, SalePhase.PRIMARY_SALE)

        # FCFS VIP
        vip = router.route(
            PurchaseRequest(user_id="u-vip", tier_id="vip", quantity=1)
        )
        assert vip.success and vip.sale_mode == SaleMode.FIXED_FCFS

        # Point lottery application
        r = router.route(PurchaseRequest(user_id="u-r", tier_id="r", quantity=1))
        assert r.success and r.sale_mode == SaleMode.POINT_LOTTERY

        # FCFS S
        s = router.route(PurchaseRequest(user_id="u-s", tier_id="s", quantity=2))
        assert s.success and s.sale_mode == SaleMode.FIXED_FCFS
        assert s.total_price == 132_000 * 2

        # FCFS A
        a = router.route(PurchaseRequest(user_id="u-a", tier_id="a", quantity=3))
        assert a.success and a.sale_mode == SaleMode.FIXED_FCFS
        assert a.total_price == 99_000 * 3

        # Each mode logged
        entries = audit.query(event_id=plan.event_id)
        modes_used = {e.sale_mode for e in entries}
        assert modes_used == {
            "point_lottery", "fixed_fcfs",
        }


class TestCancellationReallocation:
    """Purchase -> cancel -> waitlist user gets the seat."""

    def test_cancel_and_reallocate(self):
        audit = AuditLog()
        waitlist = Waitlist()
        notif = NotificationService()
        router = ModeRouter(audit_log=audit, waitlist=waitlist, notifications=notif)

        # Tiny fanclub tier with 2 seats
        fc = SeatTierConfig(
            tier_id="fc-vip", tier_name="VIP 팬클럽",
            total_seats=2, face_price=220_000,
            sale_mode=SaleMode.FANCLUB_PRESALE,
            fanclub_discount_pct=10.0,
        )
        plan = _full_plan(tiers=[fc], phases=[
            PhaseConfig(
                phase=SalePhase.FANCLUB_PRESALE,
                starts_at=_PRESALE_START,
                ends_at=_PRESALE_START + timedelta(days=1),
                applicable_tiers=["fc-vip"],
            ),
        ])
        router.initialize(plan)

        # Two fans buy the seats
        r1 = router.route(PurchaseRequest(user_id="fan-A", tier_id="fc-vip", quantity=1))
        r2 = router.route(PurchaseRequest(user_id="fan-B", tier_id="fc-vip", quantity=1))
        assert r1.success and r2.success

        # Third fan is waitlisted
        r3 = router.route(
            PurchaseRequest(user_id="fan-C", tier_id="fc-vip", quantity=1, fan_weight=2.0)
        )
        assert r3.success is False
        assert r3.waitlist_position is not None

        # fan-A cancels -> waitlist processes cancellation
        price = 220_000 * 0.9
        reallocs = waitlist.process_cancellation(
            tier_id="fc-vip", freed_seats=1,
            cancelled_by="fan-A", price=price,
        )
        assert len(reallocs) == 1
        assert reallocs[0].user_id == "fan-C"

        # Send notification for the reallocation
        notif.notify_cancellation_offer(
            event_id=plan.event_id, tier_id="fc-vip",
            user_id="fan-C", price=price,
        )
        pending = notif.get_pending(user_id="fan-C")
        assert len(pending) >= 1
        assert pending[0].data["price"] == price


class TestGroupPurchaseFCFS:
    """Group purchase: multiple seats in a single FCFS request."""

    def test_group_of_four_at_face_price(self):
        _, router, audit, _, _, plan = _build_system()

        req = PurchaseRequest(
            user_id="group-leader", tier_id="s",
            quantity=4, group_id="grp-001",
        )
        result = router.route(req)

        assert result.success is True
        assert result.total_price == 132_000 * 4
        assert router.get_remaining("s") == 800 - 4

        # Audit captures the quantity
        entries = audit.query(event_id=plan.event_id, user_id="group-leader")
        assert len(entries) == 1
        assert entries[0].details["quantity"] == 4

    def test_group_exceeds_remaining_fails(self):
        """Group request for more seats than available should be rejected."""
        audit = AuditLog()
        waitlist = Waitlist()
        notif = NotificationService()
        router = ModeRouter(audit_log=audit, waitlist=waitlist, notifications=notif)

        small_tier = SeatTierConfig(
            tier_id="s", tier_name="S석", total_seats=3,
            face_price=132_000, sale_mode=SaleMode.FIXED_FCFS,
        )
        plan = _full_plan(tiers=[small_tier], phases=[
            PhaseConfig(
                phase=SalePhase.PRIMARY_SALE,
                starts_at=_PRIMARY_START,
                ends_at=_PRIMARY_START + timedelta(days=7),
                applicable_tiers=["s"],
            ),
        ])
        router.initialize(plan)

        result = router.route(
            PurchaseRequest(user_id="big-group", tier_id="s", quantity=4, group_id="grp-big")
        )
        assert result.success is False
        assert router.get_remaining("s") == 3  # unchanged


class TestFanclubSoldOutWaitlistReallocation:
    """Fanclub sold out -> multiple fans waitlisted -> cancellation -> highest-priority gets seat."""

    def test_waitlist_priority_and_notification(self):
        audit = AuditLog()
        waitlist = Waitlist()
        notif = NotificationService()
        router = ModeRouter(audit_log=audit, waitlist=waitlist, notifications=notif)

        fc = SeatTierConfig(
            tier_id="fc-vip", tier_name="VIP 팬클럽",
            total_seats=1, face_price=220_000,
            sale_mode=SaleMode.FANCLUB_PRESALE,
            fanclub_discount_pct=15.0,
        )
        plan = _full_plan(tiers=[fc], phases=[
            PhaseConfig(
                phase=SalePhase.FANCLUB_PRESALE,
                starts_at=_PRESALE_START,
                ends_at=_PRESALE_START + timedelta(days=1),
                applicable_tiers=["fc-vip"],
            ),
        ])
        router.initialize(plan)

        # One winner buys the seat
        winner = router.route(
            PurchaseRequest(user_id="fan-winner", tier_id="fc-vip", quantity=1)
        )
        assert winner.success is True

        # Three fans get waitlisted with different weights
        for uid, weight in [("fan-low", 1.0), ("fan-high", 3.0), ("fan-mid", 2.0)]:
            r = router.route(
                PurchaseRequest(user_id=uid, tier_id="fc-vip", quantity=1, fan_weight=weight)
            )
            assert r.success is False
            assert r.waitlist_position is not None

        # Waitlist should be ordered by priority (highest first)
        entries = waitlist.get_entries("fc-vip")
        assert entries[0].user_id == "fan-high"
        assert entries[1].user_id == "fan-mid"
        assert entries[2].user_id == "fan-low"

        # Winner cancels
        price = 220_000 * 0.85
        reallocs = waitlist.process_cancellation(
            tier_id="fc-vip", freed_seats=1,
            cancelled_by="fan-winner", price=price,
        )
        assert len(reallocs) == 1
        assert reallocs[0].user_id == "fan-high"  # highest priority

        # Notify the reallocated user
        notif.notify_cancellation_offer(
            event_id=plan.event_id, tier_id="fc-vip",
            user_id="fan-high", price=price,
        )
        offers = notif.get_pending(user_id="fan-high")
        assert any("available" in n.message.lower() for n in offers)

        # Remaining waitlist should have 2 entries
        assert waitlist.size("fc-vip") == 2


class TestAuditTrailCoverage:
    """Audit trail captures every operation across all sale modes."""

    def test_audit_entries_for_all_mode_types(self):
        scheduler, router, audit, _, _, plan = _build_system()
        scheduler.transition(plan.event_id, SalePhase.PRIMARY_SALE)

        # Issue one request per mode type
        router.route(PurchaseRequest(user_id="u1", tier_id="vip", quantity=1))
        router.route(PurchaseRequest(user_id="u2", tier_id="r", quantity=1))
        router.route(PurchaseRequest(user_id="u3", tier_id="s", quantity=1))
        router.route(PurchaseRequest(user_id="u4", tier_id="a", quantity=1))
        router.route(PurchaseRequest(user_id="u5", tier_id="fc-vip", quantity=1))

        entries = audit.query(event_id=plan.event_id)
        assert len(entries) == 5

        # Verify each entry has the expected fields populated
        for entry in entries:
            assert entry.audit_id  # non-empty UUID
            assert entry.event_id == plan.event_id
            assert entry.user_id
            assert entry.tier_id
            assert entry.sale_mode
            assert entry.result in ("success", "failed")

        # Verify the user-to-mode mapping is correct
        user_modes = {e.user_id: e.sale_mode for e in entries}
        assert user_modes["u1"] == "fixed_fcfs"
        assert user_modes["u2"] == "point_lottery"
        assert user_modes["u3"] == "fixed_fcfs"
        assert user_modes["u4"] == "fixed_fcfs"
        assert user_modes["u5"] == "fanclub_presale"

    def test_failed_operations_also_audited(self):
        """Rejected requests (sold-out) still create audit entries."""
        audit = AuditLog()
        waitlist = Waitlist()
        notif = NotificationService()
        router = ModeRouter(audit_log=audit, waitlist=waitlist, notifications=notif)

        # Single FCFS tier with 1 seat
        tiny_tier = SeatTierConfig(
            tier_id="s", tier_name="S석", total_seats=1,
            face_price=132_000, sale_mode=SaleMode.FIXED_FCFS,
        )
        plan = _full_plan(tiers=[tiny_tier], phases=[
            PhaseConfig(
                phase=SalePhase.PRIMARY_SALE,
                starts_at=_PRIMARY_START,
                ends_at=_PRIMARY_START + timedelta(days=7),
                applicable_tiers=["s"],
            ),
        ])
        router.initialize(plan)

        # Buy the only seat
        router.route(PurchaseRequest(user_id="buyer1", tier_id="s", quantity=1))
        # Next request should fail (sold out)
        router.route(PurchaseRequest(user_id="buyer2", tier_id="s", quantity=1))

        entries = audit.query(event_id=plan.event_id)
        failed_entries = [e for e in entries if e.result == "failed"]
        assert len(failed_entries) >= 1


class TestLotteryIntegration:
    """Run point lottery through the orchestrator and verify results."""

    def test_lottery_draw_through_router(self):
        """Submit applications via route(), then run_tier_lottery()."""
        _, router, _, _, _, plan = _build_system()

        # 10 applicants for R tier (500 seats)
        for i in range(10):
            result = router.route(
                PurchaseRequest(user_id=f"applicant-{i}", tier_id="r", quantity=1)
            )
            assert result.success is True

        # Run the lottery with a fixed seed for reproducibility
        lottery_result = router.run_tier_lottery("r", seed=42)
        assert lottery_result is not None
        assert lottery_result.total_applicants == 10
        assert lottery_result.total_seats == 500
        # With 10 applicants and 500 seats, all should win
        assert len(lottery_result.winners) == 10
        assert len(lottery_result.waitlist) == 0


class TestCrossSessionIntegration:
    """Multi-session tour: loser bonus and duplicate win limits."""

    def test_loser_bonus_applied_to_next_session(self):
        """User loses session 1, gets bonus weight in session 2."""
        history = SessionHistory()
        policy = MultiSessionPolicy(max_wins_per_user=2, loser_bonus_weight=0.05)

        # Session 1: user lost
        history.add_record(SessionRecord(
            artist_id="artist-aespa", event_id="session-1",
            user_id="fan-unlucky", session_number=1,
            participated=True, won=False, price_paid=0.0,
        ))

        # Compute bonus for session 2
        bonus = compute_loser_bonus(
            history, "fan-unlucky", "artist-aespa",
            bonus_per_loss=policy.loser_bonus_weight,
        )
        assert bonus == pytest.approx(0.05)

        # Session 2: user lost again
        history.add_record(SessionRecord(
            artist_id="artist-aespa", event_id="session-2",
            user_id="fan-unlucky", session_number=2,
            participated=True, won=False, price_paid=0.0,
        ))
        bonus2 = compute_loser_bonus(
            history, "fan-unlucky", "artist-aespa",
            bonus_per_loss=policy.loser_bonus_weight,
        )
        assert bonus2 == pytest.approx(0.10)  # 2 consecutive losses

    def test_cross_session_adjustments_filter_and_boost(self):
        """apply_cross_session_adjustments: blocks over-limit, boosts losers."""
        history = SessionHistory()
        policy = MultiSessionPolicy(max_wins_per_user=1, loser_bonus_weight=0.05)

        # User A won session 1
        history.add_record(SessionRecord(
            artist_id="artist-aespa", event_id="s1",
            user_id="uA", session_number=1,
            participated=True, won=True, price_paid=300_000,
        ))
        # User B lost session 1
        history.add_record(SessionRecord(
            artist_id="artist-aespa", event_id="s1",
            user_id="uB", session_number=1,
            participated=True, won=False, price_paid=0.0,
        ))

        user_weights = {"uA": 1.0, "uB": 1.0, "uC": 1.0}

        adjusted, filtered = apply_cross_session_adjustments(
            user_weights=user_weights,
            artist_id="artist-aespa",
            history=history,
            max_wins=policy.max_wins_per_user,
            bonus_per_loss=policy.loser_bonus_weight,
        )

        # User A should be filtered (already won 1 session, max_wins=1)
        assert len(filtered) == 1
        assert "uA" in filtered

        # User B should have boosted weight (1 loss × 0.05 = 1.05)
        assert "uB" in adjusted
        assert adjusted["uB"] == pytest.approx(1.05)

        # User C unchanged (no history)
        assert adjusted["uC"] == pytest.approx(1.0)


class TestPaymentExpiryReallocationChain:
    """Payment expires → seats freed → waitlist reallocation → notification."""

    def test_expire_then_reallocate(self):
        audit = AuditLog()
        waitlist = Waitlist()
        notif = NotificationService()
        router = ModeRouter(audit_log=audit, waitlist=waitlist, notifications=notif)

        fc = SeatTierConfig(
            tier_id="fc", tier_name="FC",
            total_seats=2, face_price=100_000,
            sale_mode=SaleMode.FANCLUB_PRESALE,
            fanclub_discount_pct=0.0,
        )
        plan = _full_plan(tiers=[fc], phases=[
            PhaseConfig(
                phase=SalePhase.FANCLUB_PRESALE,
                starts_at=_PRESALE_START,
                ends_at=_PRESALE_START + timedelta(days=1),
                applicable_tiers=["fc"],
            ),
        ])
        router.initialize(plan)

        # Two winners
        router.route(PurchaseRequest(user_id="w1", tier_id="fc", quantity=1))
        router.route(PurchaseRequest(user_id="w2", tier_id="fc", quantity=1))

        # One waitlisted
        router.route(PurchaseRequest(user_id="w3", tier_id="fc", quantity=1, fan_weight=1.5))
        assert waitlist.size("fc") == 1

        # w1 gets pending payment
        pending = waitlist.add_pending_payment("w1", "fc", ["seat-1"], price=100_000, deadline_minutes=30)
        assert not pending.paid

        # Time passes, w1 doesn't pay
        future = datetime.now(timezone.utc) + timedelta(minutes=60)
        expired = waitlist.expire_unpaid(now=future)
        assert len(expired) == 1
        assert expired[0] == ("w1", "fc", 1)

        # Use the new auto-notification method to reallocate
        reallocs = router.process_cancellation_with_notification(
            tier_id="fc", freed_seats=1,
            cancelled_by="w1", price=100_000,
            deadline_minutes=30,
        )
        assert len(reallocs) == 1
        assert reallocs[0].user_id == "w3"

        # Verify notification was sent
        pending_notifs = notif.get_pending(user_id="w3")
        assert len(pending_notifs) >= 1
        assert pending_notifs[0].type == NotificationType.CANCELLATION_OFFER

        # Verify audit trail
        realloc_entries = audit.query(event_id=plan.event_id, action="reallocation")
        assert len(realloc_entries) == 1
        assert realloc_entries[0].user_id == "w3"


class TestReInitProtection:
    """Orchestrator re-initialization should be prevented."""

    def test_router_rejects_double_init(self):
        _, router, _, _, _, plan = _build_system()
        with pytest.raises(ValueError, match="already initialized"):
            router.initialize(plan)


class TestNewValidations:
    """Tests for newly added validation rules."""

    def test_quantity_upper_bound(self):
        req = PurchaseRequest(user_id="u1", tier_id="t1", quantity=11)
        with pytest.raises(ValueError, match="quantity must be <= 10"):
            req.validate()
