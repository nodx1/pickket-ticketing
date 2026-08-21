"""
Test Engine Integration
========================
Tests for the 14 engine function integrations in Phase C.

Tests collusion detection, abuse score computation, compliance/transparency
reports, pool allocation, price schedule, multi-session limits, group
validation, and cross-group validation.

These tests exercise the engine functions directly (unit-style) to verify
the integration logic without requiring a live database.
"""

import time
from datetime import datetime, timedelta, timezone

from talkfile_engine.eligibility import (
    Pool,
    compute_abuse_score,
    compute_pool_seats,
    detect_collusion_signals,
)
from talkfile_engine.audit_log import AuditLog
from talkfile_engine.dutch_auction import (
    DutchAuctionState,
    create_dutch_auction,
    get_price_schedule,
)
from talkfile_engine.multi_session import (
    SessionHistory,
    SessionRecord,
    check_multi_session_limit,
)
from talkfile_engine.group_tickets import (
    GroupRequest,
    validate_no_cross_group,
)
from talkfile_engine.notifications import (
    NotificationService,
    PriceAlert,
)
from talkfile_engine.waitlist import Waitlist, PendingPayment
from talkfile_engine.orchestrator import PhaseScheduler
from talkfile_engine.sale_modes import (
    OrchestrationPlan,
    RemainderPolicy,
    SaleMode,
    SalePhase,
    SeatTierConfig,
    PhaseConfig,
)


# ---------------------------------------------------------------------------
# #1: detect_collusion_signals()
# ---------------------------------------------------------------------------


class TestCollusionDetection:
    """Tests for detect_collusion_signals() integration."""

    def test_no_collusion_with_empty_bids(self):
        """Empty bid list should return zero scores."""
        signal = detect_collusion_signals(bids=[], total_seats=100)
        assert signal.overall_score == 0.0
        assert signal.bid_similarity_score == 0.0
        assert signal.timing_cluster_score == 0.0
        assert signal.payment_cluster_score == 0.0

    def test_no_collusion_with_normal_bids(self):
        """Diverse bids should have low collusion scores."""
        now = time.time()
        bids = [
            {
                "user_id": f"user_{i}",
                "bid_amount": 100000 + i * 10000,
                "submit_time": now + i * 60,
                "payment_method_hash": f"pm_{i}",
            }
            for i in range(10)
        ]
        signal = detect_collusion_signals(bids=bids, total_seats=5)
        assert signal.overall_score < 0.5

    def test_collusion_detected_with_identical_bids(self):
        """Many identical non-round bids should raise bid similarity score."""
        now = time.time()
        # Use a non-round amount to avoid roundness discount
        bids = [
            {
                "user_id": f"user_{i}",
                "bid_amount": 123456,
                "submit_time": now + i * 300,
                "payment_method_hash": f"pm_{i}",
            }
            for i in range(20)
        ]
        signal = detect_collusion_signals(bids=bids, total_seats=5)
        assert signal.bid_similarity_score > 0.0

    def test_collusion_detected_with_timing_clusters(self):
        """Bids arriving within 2 seconds should raise timing score."""
        now = time.time()
        bids = [
            {
                "user_id": f"user_{i}",
                "bid_amount": 100000 + i * 5000,
                "submit_time": now + i * 0.5,
                "payment_method_hash": f"pm_{i}",
            }
            for i in range(10)
        ]
        signal = detect_collusion_signals(bids=bids, total_seats=5)
        assert signal.timing_cluster_score > 0.0

    def test_collusion_detected_with_shared_payments(self):
        """Multiple users sharing payment methods should raise payment score."""
        now = time.time()
        bids = [
            {
                "user_id": f"user_{i}",
                "bid_amount": 100000 + i * 10000,
                "submit_time": now + i * 60,
                "payment_method_hash": "shared_pm",
            }
            for i in range(10)
        ]
        signal = detect_collusion_signals(bids=bids, total_seats=5)
        assert signal.payment_cluster_score > 0.0

    def test_collusion_signal_is_dataclass(self):
        """CollusionSignal should have all expected fields."""
        signal = detect_collusion_signals(
            bids=[{"user_id": "u1", "bid_amount": 100, "submit_time": 1.0}],
            total_seats=1,
        )
        assert hasattr(signal, "bid_similarity_score")
        assert hasattr(signal, "timing_cluster_score")
        assert hasattr(signal, "payment_cluster_score")
        assert hasattr(signal, "overall_score")


# ---------------------------------------------------------------------------
# #2: compute_abuse_score()
# ---------------------------------------------------------------------------


class TestAbuseScore:
    """Tests for compute_abuse_score() integration."""

    def test_clean_user_has_zero_score(self):
        """A user with no abuse signals should have 0 score."""
        score = compute_abuse_score()
        assert score == 0.0

    def test_bot_signature_detected(self):
        """Bot signature should add 0.5 to score."""
        score = compute_abuse_score(bot_signature_detected=True)
        assert score == 0.5

    def test_multi_account_same_ip_two(self):
        """Two accounts on same IP should add 0.1."""
        score = compute_abuse_score(multi_account_same_ip=2)
        assert score == 0.1

    def test_multi_account_same_ip_three_plus(self):
        """Three+ accounts on same IP should add 0.3."""
        score = compute_abuse_score(multi_account_same_ip=3)
        assert score == 0.3

    def test_rapid_cancel_three(self):
        """3 rapid cancels should add 0.15."""
        score = compute_abuse_score(rapid_cancel_count=3)
        assert score == 0.15

    def test_rapid_cancel_five(self):
        """5+ rapid cancels should add 0.3."""
        score = compute_abuse_score(rapid_cancel_count=5)
        assert score == 0.3

    def test_combined_abuse_capped_at_one(self):
        """Combined abuse factors should be capped at 1.0."""
        score = compute_abuse_score(
            multi_account_same_ip=5,
            rapid_cancel_count=10,
            bot_signature_detected=True,
        )
        assert score == 1.0

    def test_abuse_score_below_threshold_is_not_blocked(self):
        """Score below 0.7 should not block user."""
        score = compute_abuse_score(multi_account_same_ip=2)
        assert score < 0.7

    def test_abuse_score_above_threshold_blocks(self):
        """Score above 0.7 should trigger a block."""
        score = compute_abuse_score(
            multi_account_same_ip=3,
            rapid_cancel_count=5,
            bot_signature_detected=True,
        )
        assert score > 0.7


# ---------------------------------------------------------------------------
# #3: generate_compliance_report()
# ---------------------------------------------------------------------------


class TestComplianceReport:
    """Tests for AuditLog.generate_compliance_report() integration."""

    def test_empty_compliance_report(self):
        """Compliance report for event with no entries should have 0 transactions."""
        audit_log = AuditLog()
        report = audit_log.generate_compliance_report("event_1")
        assert report["event_id"] == "event_1"
        assert report["total_transactions"] == 0
        assert report["transactions"] == []
        assert "generated_at" in report

    def test_compliance_report_with_entries(self):
        """Compliance report should include all transactions."""
        audit_log = AuditLog()
        audit_log.log(
            event_id="event_1",
            action="purchase",
            user_id="user_1",
            tier_id="tier_1",
            sale_mode="point_lottery",
            details={"price": 150000, "identity_verified": True},
        )
        audit_log.log(
            event_id="event_1",
            action="bid",
            user_id="user_2",
            tier_id="tier_1",
            sale_mode="point_lottery",
            details={"price": 120000},
        )

        report = audit_log.generate_compliance_report("event_1")
        assert report["total_transactions"] == 2
        assert len(report["transactions"]) == 2
        # User IDs should be hashed
        for tx in report["transactions"]:
            assert "user_id_hash" in tx
            assert len(tx["user_id_hash"]) == 12

    def test_compliance_report_filters_by_event(self):
        """Compliance report should only include entries for the given event."""
        audit_log = AuditLog()
        audit_log.log(
            event_id="event_1",
            action="purchase",
            user_id="user_1",
            tier_id="t1",
            sale_mode="vcg",
        )
        audit_log.log(
            event_id="event_2",
            action="purchase",
            user_id="user_2",
            tier_id="t2",
            sale_mode="vcg",
        )
        report = audit_log.generate_compliance_report("event_1")
        assert report["total_transactions"] == 1


# ---------------------------------------------------------------------------
# #4: generate_transparency_report()
# ---------------------------------------------------------------------------


class TestTransparencyReport:
    """Tests for AuditLog.generate_transparency_report() integration."""

    def test_empty_transparency_report(self):
        """Transparency report with no entries should have 0 sold."""
        audit_log = AuditLog()
        report = audit_log.generate_transparency_report("event_1", "tier_1")
        assert report["event_id"] == "event_1"
        assert report["tier_id"] == "tier_1"
        assert report["total_sold"] == 0

    def test_transparency_report_with_purchases(self):
        """Transparency report should show purchase stats."""
        audit_log = AuditLog()
        for i in range(5):
            audit_log.log(
                event_id="event_1",
                action="purchase",
                user_id=f"user_{i}",
                tier_id="tier_1",
                sale_mode="point_lottery",
                details={"price": 100000 + i * 10000},
            )

        report = audit_log.generate_transparency_report("event_1", "tier_1")
        assert report["total_sold"] == 5
        assert report["price_min"] == 100000
        assert report["price_max"] == 140000
        assert "participant_band" in report
        assert "allocation_method" in report

    def test_transparency_report_no_personal_data(self):
        """Transparency report should NOT contain user IDs."""
        audit_log = AuditLog()
        audit_log.log(
            event_id="event_1",
            action="purchase",
            user_id="sensitive_user_id",
            tier_id="tier_1",
            sale_mode="vcg",
            details={"price": 100000},
        )
        report = audit_log.generate_transparency_report("event_1", "tier_1")
        # No user_id field in the public report
        assert "user_id" not in report
        assert "sensitive_user_id" not in str(report)


# ---------------------------------------------------------------------------
# #5: compute_pool_seats()
# ---------------------------------------------------------------------------


class TestPoolAllocation:
    """Tests for compute_pool_seats() integration."""

    def test_pool_allocation_100_seats(self):
        """100 seats should distribute according to default ratios."""
        seats = compute_pool_seats(100)
        assert seats[Pool.A] == 65
        assert seats[Pool.B] == 15
        assert seats[Pool.C] == 10
        assert seats[Pool.D] == 10
        assert sum(seats.values()) == 100

    def test_pool_allocation_1_seat(self):
        """1 seat should go entirely to Pool A (remainder)."""
        seats = compute_pool_seats(1)
        assert sum(seats.values()) == 1
        assert seats[Pool.A] == 1

    def test_pool_allocation_1000_seats(self):
        """1000 seats should distribute according to ratios."""
        seats = compute_pool_seats(1000)
        assert seats[Pool.A] == 650
        assert seats[Pool.B] == 150
        assert seats[Pool.C] == 100
        assert seats[Pool.D] == 100
        assert sum(seats.values()) == 1000

    def test_pool_allocation_total_always_matches(self):
        """Total allocated should always equal input total."""
        for total in [7, 13, 50, 99, 500, 1234]:
            seats = compute_pool_seats(total)
            assert sum(seats.values()) == total, f"Failed for total={total}"


# ---------------------------------------------------------------------------
# #10: get_price_schedule()
# ---------------------------------------------------------------------------


class TestPriceSchedule:
    """Tests for get_price_schedule() integration."""

    def test_price_schedule_returns_steps(self):
        """Price schedule should show decreasing prices."""
        now = datetime.now(timezone.utc)
        state = create_dutch_auction(
            tier_id="tier_1",
            start_price=200000,
            floor_price=100000,
            step_amount=20000,
            step_interval_minutes=60,
            total_seats=50,
            start_at=now,
        )
        schedule = get_price_schedule(state)

        assert len(schedule) > 0
        # First entry should be at start_price
        assert schedule[0][1] == 200000
        # Last entry should be at floor_price
        assert schedule[-1][1] == 100000
        # Prices should be non-increasing
        for i in range(len(schedule) - 1):
            assert schedule[i][1] >= schedule[i + 1][1]

    def test_price_schedule_empty_when_not_started(self):
        """Price schedule should be empty when auction hasn't started."""
        state = DutchAuctionState(
            tier_id="tier_1",
            start_price=200000,
            floor_price=100000,
            step_amount=20000,
            step_interval_minutes=60,
            remaining_seats=50,
            started_at=None,
        )
        schedule = get_price_schedule(state)
        assert schedule == []

    def test_price_schedule_correct_step_count(self):
        """Number of steps should match (start - floor) / step_amount + 1."""
        now = datetime.now(timezone.utc)
        state = create_dutch_auction(
            tier_id="tier_1",
            start_price=100000,
            floor_price=50000,
            step_amount=10000,
            step_interval_minutes=30,
            total_seats=10,
            start_at=now,
        )
        schedule = get_price_schedule(state)
        # 100k -> 90k -> 80k -> 70k -> 60k -> 50k = 6 entries
        assert len(schedule) == 6

    def test_price_schedule_time_intervals(self):
        """Time intervals between steps should match step_interval_minutes."""
        now = datetime.now(timezone.utc)
        state = create_dutch_auction(
            tier_id="tier_1",
            start_price=100000,
            floor_price=80000,
            step_amount=10000,
            step_interval_minutes=15,
            total_seats=10,
            start_at=now,
        )
        schedule = get_price_schedule(state)
        for i in range(len(schedule) - 1):
            diff = (schedule[i + 1][0] - schedule[i][0]).total_seconds()
            assert diff == 15 * 60  # 15 minutes in seconds


# ---------------------------------------------------------------------------
# #9: check_multi_session_limit()
# ---------------------------------------------------------------------------


class TestMultiSessionLimit:
    """Tests for check_multi_session_limit() integration."""

    def test_eligible_with_no_history(self):
        """User with no history should be eligible."""
        history = SessionHistory()
        eligible, reason = check_multi_session_limit(
            history=history, user_id="user_1", artist_id="artist_1"
        )
        assert eligible is True
        assert reason == "Eligible"

    def test_eligible_with_one_win(self):
        """User with 1 win (max 2) should still be eligible."""
        history = SessionHistory()
        history.add_record(
            SessionRecord(
                user_id="user_1",
                artist_id="artist_1",
                session_number=1,
                event_id="event_1",
                participated=True,
                won=True,
            )
        )
        eligible, reason = check_multi_session_limit(
            history=history, user_id="user_1", artist_id="artist_1"
        )
        assert eligible is True

    def test_blocked_at_max_wins(self):
        """User at max wins should be blocked."""
        history = SessionHistory()
        for i in range(2):
            history.add_record(
                SessionRecord(
                    user_id="user_1",
                    artist_id="artist_1",
                    session_number=i + 1,
                    event_id=f"event_{i}",
                    participated=True,
                    won=True,
                )
            )
        eligible, reason = check_multi_session_limit(
            history=history,
            user_id="user_1",
            artist_id="artist_1",
            max_wins=2,
        )
        assert eligible is False
        assert "Maximum" in reason

    def test_different_artist_not_affected(self):
        """Wins for a different artist should not affect eligibility."""
        history = SessionHistory()
        for i in range(5):
            history.add_record(
                SessionRecord(
                    user_id="user_1",
                    artist_id="other_artist",
                    session_number=i + 1,
                    event_id=f"event_{i}",
                    participated=True,
                    won=True,
                )
            )
        eligible, reason = check_multi_session_limit(
            history=history, user_id="user_1", artist_id="target_artist"
        )
        assert eligible is True

    def test_losses_dont_count_toward_limit(self):
        """Losses should not count toward the win limit."""
        history = SessionHistory()
        for i in range(10):
            history.add_record(
                SessionRecord(
                    user_id="user_1",
                    artist_id="artist_1",
                    session_number=i + 1,
                    event_id=f"event_{i}",
                    participated=True,
                    won=False,
                )
            )
        eligible, reason = check_multi_session_limit(
            history=history, user_id="user_1", artist_id="artist_1"
        )
        assert eligible is True


# ---------------------------------------------------------------------------
# #11 & #12: group_tickets.validate() and validate_no_cross_group()
# ---------------------------------------------------------------------------


class TestGroupValidation:
    """Tests for GroupRequest.validate() and validate_no_cross_group()."""

    def test_valid_group(self):
        """A properly formed group should validate."""
        group = GroupRequest(
            group_id="g1",
            leader_user_id="user_1",
            member_user_ids=["user_1", "user_2", "user_3"],
        )
        valid, reason = group.validate(max_group_size=4)
        assert valid is True
        assert reason == "Valid"

    def test_group_too_large(self):
        """Group exceeding max size should fail."""
        group = GroupRequest(
            group_id="g1",
            leader_user_id="user_1",
            member_user_ids=["user_1", "user_2", "user_3", "user_4", "user_5"],
        )
        valid, reason = group.validate(max_group_size=4)
        assert valid is False
        assert "exceeds max" in reason

    def test_group_leader_not_in_members(self):
        """Leader not in member list should fail."""
        group = GroupRequest(
            group_id="g1",
            leader_user_id="leader",
            member_user_ids=["user_1", "user_2"],
        )
        valid, reason = group.validate()
        assert valid is False
        assert "leader must be in" in reason

    def test_group_single_member(self):
        """Group with only 1 member should fail."""
        group = GroupRequest(
            group_id="g1",
            leader_user_id="user_1",
            member_user_ids=["user_1"],
        )
        valid, reason = group.validate()
        assert valid is False
        assert "at least 2" in reason

    def test_group_duplicate_members(self):
        """Group with duplicate members should fail."""
        group = GroupRequest(
            group_id="g1",
            leader_user_id="user_1",
            member_user_ids=["user_1", "user_1"],
        )
        valid, reason = group.validate()
        assert valid is False
        assert "Duplicate" in reason

    def test_no_cross_group_valid(self):
        """Users in separate groups should pass validation."""
        groups = [
            GroupRequest(group_id="g1", leader_user_id="u1", member_user_ids=["u1", "u2"]),
            GroupRequest(group_id="g2", leader_user_id="u3", member_user_ids=["u3", "u4"]),
        ]
        valid, reason = validate_no_cross_group(groups)
        assert valid is True

    def test_cross_group_detected(self):
        """User in multiple groups should fail validation."""
        groups = [
            GroupRequest(group_id="g1", leader_user_id="u1", member_user_ids=["u1", "u2"]),
            GroupRequest(group_id="g2", leader_user_id="u2", member_user_ids=["u2", "u3"]),
        ]
        valid, reason = validate_no_cross_group(groups)
        assert valid is False
        assert "u2" in reason
        assert "multiple groups" in reason


# ---------------------------------------------------------------------------
# Engine Waitlist expire_unpaid()
# ---------------------------------------------------------------------------


class TestWaitlistExpireUnpaid:
    """Tests for Waitlist.expire_unpaid() integration."""

    def test_expire_unpaid_returns_expired(self):
        """Expired pending payments should be returned."""
        waitlist = Waitlist()
        past = datetime.now(timezone.utc) - timedelta(hours=1)
        waitlist._pending_payments.append(
            PendingPayment(
                user_id="u1",
                tier_id="t1",
                seat_ids=["s1", "s2"],
                price=100000.0,
                deadline=past,
            )
        )
        expired = waitlist.expire_unpaid()
        assert len(expired) == 1
        assert expired[0] == ("u1", "t1", 2)

    def test_expire_unpaid_keeps_paid(self):
        """Paid payments should not be expired."""
        waitlist = Waitlist()
        past = datetime.now(timezone.utc) - timedelta(hours=1)
        waitlist._pending_payments.append(
            PendingPayment(
                user_id="u1",
                tier_id="t1",
                seat_ids=["s1"],
                price=100000.0,
                deadline=past,
                paid=True,
            )
        )
        expired = waitlist.expire_unpaid()
        assert len(expired) == 0

    def test_expire_unpaid_keeps_future_deadlines(self):
        """Payments with future deadlines should not be expired."""
        waitlist = Waitlist()
        future = datetime.now(timezone.utc) + timedelta(hours=1)
        waitlist._pending_payments.append(
            PendingPayment(
                user_id="u1",
                tier_id="t1",
                seat_ids=["s1"],
                price=100000.0,
                deadline=future,
            )
        )
        expired = waitlist.expire_unpaid()
        assert len(expired) == 0


# ---------------------------------------------------------------------------
# Engine NotificationService check_dutch_alerts()
# ---------------------------------------------------------------------------


class TestDutchAlerts:
    """Tests for NotificationService.check_dutch_alerts() integration."""

    def test_alert_triggered_at_target_price(self):
        """Alert should trigger when current price reaches target."""
        service = NotificationService()
        service.register_price_alert(
            PriceAlert(
                user_id="u1",
                event_id="e1",
                tier_id="t1",
                target_price=80000,
            )
        )
        triggered = service.check_dutch_alerts("e1", "t1", current_price=80000)
        assert len(triggered) == 1
        assert triggered[0].user_id == "u1"

    def test_alert_triggered_below_target(self):
        """Alert should trigger when price drops below target."""
        service = NotificationService()
        service.register_price_alert(
            PriceAlert(
                user_id="u1",
                event_id="e1",
                tier_id="t1",
                target_price=80000,
            )
        )
        triggered = service.check_dutch_alerts("e1", "t1", current_price=70000)
        assert len(triggered) == 1

    def test_alert_not_triggered_above_target(self):
        """Alert should NOT trigger when price is above target."""
        service = NotificationService()
        service.register_price_alert(
            PriceAlert(
                user_id="u1",
                event_id="e1",
                tier_id="t1",
                target_price=80000,
            )
        )
        triggered = service.check_dutch_alerts("e1", "t1", current_price=90000)
        assert len(triggered) == 0

    def test_alert_only_fires_once(self):
        """Alert should be removed after triggering (no double-fire)."""
        service = NotificationService()
        service.register_price_alert(
            PriceAlert(
                user_id="u1",
                event_id="e1",
                tier_id="t1",
                target_price=80000,
            )
        )
        service.check_dutch_alerts("e1", "t1", current_price=70000)
        triggered_again = service.check_dutch_alerts("e1", "t1", current_price=60000)
        assert len(triggered_again) == 0

    def test_multiple_alerts_for_same_event(self):
        """Multiple alerts for same event/tier should all be checked."""
        service = NotificationService()
        service.register_price_alert(
            PriceAlert(
                user_id="u1",
                event_id="e1",
                tier_id="t1",
                target_price=90000,
            )
        )
        service.register_price_alert(
            PriceAlert(
                user_id="u2",
                event_id="e1",
                tier_id="t1",
                target_price=80000,
            )
        )
        service.register_price_alert(
            PriceAlert(
                user_id="u3",
                event_id="e1",
                tier_id="t1",
                target_price=70000,
            )
        )
        triggered = service.check_dutch_alerts("e1", "t1", current_price=85000)
        # Only u1's alert (target=90000) should fire since 85000 <= 90000
        assert len(triggered) == 1
        assert triggered[0].user_id == "u1"


# ---------------------------------------------------------------------------
# PhaseScheduler integration
# ---------------------------------------------------------------------------


class TestPhaseScheduler:
    """Tests for PhaseScheduler.get_active_tiers() and should_trigger_remainder()."""

    def _make_plan(self, now=None):
        """Helper to build a test orchestration plan."""
        if now is None:
            now = datetime.now(timezone.utc)

        tier = SeatTierConfig(
            tier_id="tier_1",
            tier_name="VIP",
            total_seats=100,
            face_price=100000,
            sale_mode=SaleMode.POINT_LOTTERY,
            min_price=50000,
            max_price_cap=200000,
        )

        phase = PhaseConfig(
            phase=SalePhase.PRIMARY_SALE,
            starts_at=now - timedelta(hours=1),
            ends_at=now + timedelta(hours=1),
            applicable_tiers=["tier_1"],
        )

        return OrchestrationPlan(
            event_id="event_1",
            event_name="Test Concert",
            artist_id="artist_1",
            venue_name="Arena",
            event_date=now + timedelta(days=7),
            tiers=[tier],
            phases=[phase],
            remainder_policy=RemainderPolicy(
                trigger_hours_before_event=72,
            ),
        )

    def test_get_active_tiers_within_window(self):
        """Tiers within the active phase window should be returned."""
        now = datetime.now(timezone.utc)
        plan = self._make_plan(now)
        scheduler = PhaseScheduler()
        scheduler.initialize(plan)

        active = scheduler.get_active_tiers(plan, now)
        assert len(active) == 1
        assert active[0].tier_id == "tier_1"

    def test_get_active_tiers_outside_window(self):
        """Tiers outside the phase window should not be returned."""
        now = datetime.now(timezone.utc)
        plan = self._make_plan(now)
        scheduler = PhaseScheduler()
        scheduler.initialize(plan)

        future = now + timedelta(hours=5)
        active = scheduler.get_active_tiers(plan, future)
        assert len(active) == 0

    def test_should_trigger_remainder_false_before_time(self):
        """Remainder should not trigger before the configured time."""
        now = datetime.now(timezone.utc)
        plan = self._make_plan(now)
        scheduler = PhaseScheduler()
        scheduler.initialize(plan)

        result = scheduler.should_trigger_remainder(
            plan=plan,
            now=now,
            unsold_counts={"tier_1": 50},
        )
        # Event is 7 days away, trigger is 72h before = 4 days away
        assert result is False

    def test_should_trigger_remainder_true_when_close(self):
        """Remainder should trigger when close enough to event date."""
        now = datetime.now(timezone.utc)
        plan = self._make_plan(now)
        plan.event_date = now + timedelta(hours=24)  # Event in 24h

        scheduler = PhaseScheduler()
        scheduler.initialize(plan)

        result = scheduler.should_trigger_remainder(
            plan=plan,
            now=now,
            unsold_counts={"tier_1": 50},
        )
        assert result is True

    def test_should_trigger_remainder_false_when_no_unsold(self):
        """Remainder should not trigger if no unsold seats."""
        now = datetime.now(timezone.utc)
        plan = self._make_plan(now)
        plan.event_date = now + timedelta(hours=24)

        scheduler = PhaseScheduler()
        scheduler.initialize(plan)

        result = scheduler.should_trigger_remainder(
            plan=plan,
            now=now,
            unsold_counts={},
        )
        assert result is False
