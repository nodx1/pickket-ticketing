"""
Sale Modes & Data Models Tests
================================
Tests for RISE orchestration layer data models:
  - SeatTierConfig validation per sale mode
  - SalePhase transitions
  - OrchestrationPlan validation
  - PurchaseRequest validation
  - RemainderPolicy / MultiSessionPolicy validation
"""

from datetime import datetime, timedelta, timezone

import pytest

from talkfile_engine.sale_modes import (
    MultiSessionPolicy,
    OrchestrationPlan,
    PhaseConfig,
    PurchaseRequest,
    RemainderPolicy,
    SaleMode,
    SalePhase,
    SeatTierConfig,
    VALID_PHASE_TRANSITIONS,
)


# ─── Helpers ───


def _make_tier(mode: SaleMode, **overrides) -> SeatTierConfig:
    """Build a valid SeatTierConfig for the given mode with sane defaults."""
    defaults = dict(
        tier_id="t1",
        tier_name="VIP",
        total_seats=100,
        face_price=100_000.0,
        sale_mode=mode,
    )
    if mode == SaleMode.FANCLUB_PRESALE:
        defaults.update(fanclub_discount_pct=15.0)
    elif mode == SaleMode.POINT_LOTTERY:
        defaults.update(lottery_application_hours=48)
    # FIXED_FCFS needs no extra fields
    defaults.update(overrides)
    return SeatTierConfig(**defaults)


def _make_plan(**overrides) -> OrchestrationPlan:
    """Build a minimal valid OrchestrationPlan."""
    now = datetime.now(timezone.utc)
    tier = _make_tier(SaleMode.FIXED_FCFS)
    phase = PhaseConfig(
        phase=SalePhase.PRIMARY_SALE,
        starts_at=now,
        ends_at=now + timedelta(hours=2),
        applicable_tiers=["t1"],
    )
    defaults = dict(
        event_id="evt-001",
        event_name="Concert",
        artist_id="artist-001",
        venue_name="Arena",
        event_date=now + timedelta(days=30),
        tiers=[tier],
        phases=[phase],
        remainder_policy=RemainderPolicy(),
    )
    defaults.update(overrides)
    return OrchestrationPlan(**defaults)


# ─── SeatTierConfig.validate() per mode ───


class TestSeatTierConfigValidation:
    """Validate SeatTierConfig for each sale mode and invalid inputs."""

    def test_point_lottery_valid(self):
        tier = _make_tier(SaleMode.POINT_LOTTERY)
        tier.validate()

    def test_fanclub_valid(self):
        tier = _make_tier(SaleMode.FANCLUB_PRESALE)
        tier.validate()

    def test_fcfs_valid(self):
        tier = _make_tier(SaleMode.FIXED_FCFS)
        tier.validate()

    def test_negative_seats_rejected(self):
        tier = _make_tier(SaleMode.FIXED_FCFS, total_seats=-1)
        with pytest.raises(ValueError, match="total_seats must be positive"):
            tier.validate()

    def test_negative_face_price_rejected(self):
        tier = _make_tier(SaleMode.FIXED_FCFS, face_price=-10.0)
        with pytest.raises(ValueError, match="face_price must be non-negative"):
            tier.validate()

    def test_lottery_hours_out_of_range_rejected(self):
        tier = _make_tier(SaleMode.POINT_LOTTERY, lottery_application_hours=200)
        with pytest.raises(ValueError, match="lottery_application_hours"):
            tier.validate()

    def test_fanclub_discount_out_of_range_rejected(self):
        tier = _make_tier(SaleMode.FANCLUB_PRESALE, fanclub_discount_pct=150.0)
        with pytest.raises(ValueError, match="fanclub_discount_pct"):
            tier.validate()

    def test_max_group_size_out_of_range_rejected(self):
        tier = _make_tier(SaleMode.FIXED_FCFS, max_group_size=15)
        with pytest.raises(ValueError, match="max_group_size"):
            tier.validate()


# ─── SalePhase transitions ───


class TestSalePhaseTransitions:
    """Verify VALID_PHASE_TRANSITIONS table."""

    def test_setup_can_go_to_fanclub_or_primary(self):
        expected = {SalePhase.FANCLUB_PRESALE, SalePhase.PRIMARY_SALE}
        assert set(VALID_PHASE_TRANSITIONS[SalePhase.SETUP]) == expected

    def test_fanclub_can_go_to_primary_only(self):
        assert VALID_PHASE_TRANSITIONS[SalePhase.FANCLUB_PRESALE] == [SalePhase.PRIMARY_SALE]

    def test_primary_can_go_to_remainder_or_closed(self):
        expected = {SalePhase.REMAINDER_SALE, SalePhase.CLOSED}
        assert set(VALID_PHASE_TRANSITIONS[SalePhase.PRIMARY_SALE]) == expected

    def test_closed_is_terminal(self):
        assert VALID_PHASE_TRANSITIONS[SalePhase.CLOSED] == []


# ─── OrchestrationPlan.validate() ───


class TestOrchestrationPlanValidation:
    """Validate OrchestrationPlan: valid plan, duplicates, ordering, unknown refs."""

    def test_valid_plan_passes(self):
        plan = _make_plan()
        plan.validate()

    def test_duplicate_tier_ids_rejected(self):
        tier1 = _make_tier(SaleMode.FIXED_FCFS, tier_id="dup")
        tier2 = _make_tier(SaleMode.FIXED_FCFS, tier_id="dup", tier_name="Standard")
        plan = _make_plan(tiers=[tier1, tier2])
        with pytest.raises(ValueError, match="Duplicate tier_id"):
            plan.validate()

    def test_out_of_order_phases_rejected(self):
        now = datetime.now(timezone.utc)
        phase1 = PhaseConfig(
            phase=SalePhase.PRIMARY_SALE,
            starts_at=now + timedelta(hours=5),
            ends_at=now + timedelta(hours=7),
            applicable_tiers=["t1"],
        )
        phase2 = PhaseConfig(
            phase=SalePhase.REMAINDER_SALE,
            starts_at=now + timedelta(hours=1),
            ends_at=now + timedelta(hours=3),
            applicable_tiers=["t1"],
        )
        plan = _make_plan(phases=[phase1, phase2])
        with pytest.raises(ValueError, match="chronological"):
            plan.validate()

    def test_unknown_tier_ref_in_phase_rejected(self):
        now = datetime.now(timezone.utc)
        phase = PhaseConfig(
            phase=SalePhase.PRIMARY_SALE,
            starts_at=now,
            ends_at=now + timedelta(hours=2),
            applicable_tiers=["nonexistent_tier"],
        )
        plan = _make_plan(phases=[phase])
        with pytest.raises(ValueError, match="unknown tier_id"):
            plan.validate()

    def test_price_cap_multiplier_below_one_rejected(self):
        plan = _make_plan(price_cap_multiplier=0.5)
        with pytest.raises(ValueError, match="price_cap_multiplier"):
            plan.validate()


# ─── PurchaseRequest.validate() ───


class TestPurchaseRequestValidation:
    """Validate PurchaseRequest fields."""

    def test_valid_request_passes(self):
        req = PurchaseRequest(user_id="u1", tier_id="t1", quantity=2)
        req.validate()

    def test_empty_user_id_rejected(self):
        req = PurchaseRequest(user_id="", tier_id="t1")
        with pytest.raises(ValueError, match="user_id"):
            req.validate()

    def test_zero_quantity_rejected(self):
        req = PurchaseRequest(user_id="u1", tier_id="t1", quantity=0)
        with pytest.raises(ValueError, match="quantity"):
            req.validate()

    def test_negative_bid_amount_rejected(self):
        req = PurchaseRequest(user_id="u1", tier_id="t1", bid_amount=-100.0)
        with pytest.raises(ValueError, match="bid_amount"):
            req.validate()

    def test_zero_fan_weight_rejected(self):
        req = PurchaseRequest(user_id="u1", tier_id="t1", fan_weight=0.0)
        with pytest.raises(ValueError, match="fan_weight"):
            req.validate()


# ─── RemainderPolicy.validate() ───


class TestRemainderPolicyValidation:
    """Validate RemainderPolicy."""

    def test_valid_default_passes(self):
        policy = RemainderPolicy()
        policy.validate()

    def test_unknown_strategy_rejected(self):
        policy = RemainderPolicy(strategy="random_giveaway")
        with pytest.raises(ValueError, match="Unknown strategy"):
            policy.validate()

    def test_floor_discount_out_of_range_rejected(self):
        policy = RemainderPolicy(dutch_floor_discount_pct=110.0)
        with pytest.raises(ValueError, match="dutch_floor_discount_pct"):
            policy.validate()


# ─── MultiSessionPolicy.validate() ───


class TestMultiSessionPolicyValidation:
    """Validate MultiSessionPolicy."""

    def test_valid_default_passes(self):
        policy = MultiSessionPolicy()
        policy.validate()

    def test_zero_max_wins_rejected(self):
        policy = MultiSessionPolicy(max_wins_per_user=0)
        with pytest.raises(ValueError, match="max_wins_per_user"):
            policy.validate()

    def test_loser_bonus_weight_out_of_range_rejected(self):
        policy = MultiSessionPolicy(loser_bonus_weight=0.8)
        with pytest.raises(ValueError, match="loser_bonus_weight"):
            policy.validate()
