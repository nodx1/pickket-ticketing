"""
Extended Lottery Service Tests
==============================
Unit tests for LotteryService covering uncovered paths:
  - apply() edge cases (AP validation, closed pool, event status, newcomer shield)
  - draw() paths (empty pool, guaranteed winners, VCG draw, AP refund/consolation, waitlisting)
  - verify_pool() paths (VCG vs standard verification)
  - get_transparency_report() edge cases (empty weights, VCG fairness metrics)
  - get_my_result() edge cases (user not found, weight breakdown failure)
  - compute_group_ap_cost() utility
"""

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.lottery import LotteryEntryResult, LotteryPoolStatus
from app.services.lottery_service import (
    LotteryService,
    compute_group_ap_cost,
    GROUP_AP_MULTIPLIERS,
    NEWCOMER_WEIGHT_BOOST,
    NEWCOMER_WINDOW_DAYS,
)


# ---------------------------------------------------------------------------
# Helpers — lightweight fakes for DB models
# ---------------------------------------------------------------------------

def _make_pool(
    *,
    pool_id=None,
    event_id=None,
    tier_id=None,
    total_seats=10,
    status=LotteryPoolStatus.OPEN,
    use_fan_weight=True,
    seed_used=None,
    commitment_hash=None,
    verification_data=None,
    created_at=None,
    server_seed=424242,
    seed_commitment="a" * 64,
    committed_at=None,
    drawn_at=None,
):
    pool = MagicMock()
    pool.id = pool_id or uuid.uuid4()
    pool.event_id = event_id or uuid.uuid4()
    pool.tier_id = tier_id or uuid.uuid4()
    pool.total_seats = total_seats
    pool.status = status
    pool.use_fan_weight = use_fan_weight
    pool.seed_used = seed_used
    pool.commitment_hash = commitment_hash
    pool.verification_data = verification_data
    pool.created_at = created_at or datetime.now(timezone.utc)
    # Commit-reveal v2 필드: MagicMock 자동 속성이 pydantic/json 직렬화로
    # 새지 않도록 명시 기본값 설정. 기본은 '사전 커밋이 존재하는' 풀 (draw 가능).
    pool.server_seed = server_seed
    pool.seed_commitment = seed_commitment
    pool.committed_at = committed_at or pool.created_at
    pool.drawn_at = drawn_at
    return pool


def _make_entry(
    *,
    entry_id=None,
    pool_id=None,
    user_id=None,
    group_id=None,
    group_size=1,
    fan_weight=1.0,
    client_seed=None,
    invested_ap=0,
    tier_multiplier=1.0,
    pity_bonus=1.0,
    result=LotteryEntryResult.PENDING,
    created_at=None,
):
    entry = MagicMock()
    entry.id = entry_id or uuid.uuid4()
    entry.pool_id = pool_id or uuid.uuid4()
    entry.user_id = user_id or uuid.uuid4()
    entry.group_id = group_id
    entry.group_size = group_size
    entry.fan_weight = fan_weight
    entry.client_seed = client_seed
    entry.invested_ap = invested_ap
    entry.tier_multiplier = tier_multiplier
    entry.pity_bonus = pity_bonus
    entry.result = result
    entry.created_at = created_at or datetime.now(timezone.utc)
    return entry


def _make_tier(*, tier_id=None, event_id=None, capacity=10, sold_count=0, face_price=100.0, sale_mode="point_lottery"):
    # event_id 는 필수 바인딩이다 — apply() 가 `tier.event_id != event_id` 로 크로스이벤트
    # tier 주입을 차단한다. MagicMock 기본값(자동 Mock 속성)은 절대 일치하지 않으므로
    # 명시하지 않으면 모든 apply 테스트가 그 가드에 걸린다.
    tier = MagicMock()
    tier.id = tier_id or uuid.uuid4()
    tier.event_id = event_id or uuid.uuid4()
    tier.capacity = capacity
    tier.sold_count = sold_count
    tier.face_price = face_price
    tier.sale_mode = sale_mode
    return tier


def _make_event(*, event_id=None, status="bidding_open", category="CONCERT", bidding_opens_at=None, bidding_closes_at=None):
    from app.models.event import EventStatus
    event = MagicMock()
    event.id = event_id or uuid.uuid4()
    event.status = EventStatus.BIDDING_OPEN if status == "bidding_open" else EventStatus.APPROVED
    event.category = category
    event.bidding_opens_at = bidding_opens_at or (datetime.now(timezone.utc) - timedelta(hours=1))
    event.bidding_closes_at = bidding_closes_at or (datetime.now(timezone.utc) + timedelta(hours=24))
    event.event_date = datetime.now(timezone.utc) + timedelta(days=7)
    event.resale_opens_at = None
    event.resale_closes_at = None
    return event


def _build_service(session=None):
    """Build LotteryService with a mock session and mock sub-services."""
    session = session or AsyncMock()
    # Make session.execute() return a result with .scalars().all() chain
    # (needed by draw() for Seat queries)
    mock_scalars = MagicMock()
    mock_scalars.all.return_value = []
    mock_result = MagicMock()
    mock_result.scalars.return_value = mock_scalars
    session.execute.return_value = mock_result
    svc = LotteryService(session)
    # Replace repositories and sub-services with async mocks
    svc.pool_repo = AsyncMock()
    # Default the pool getters to None so an unconfigured getter is detectable
    # (an AsyncMock leaves return_value as an auto child mock otherwise).
    svc.pool_repo.get.return_value = None
    svc.pool_repo.get_by_event_tier.return_value = None
    # _draw_inner uses get_for_update (FOR UPDATE lock) on a pool set via
    # pool_repo.get; apply() also re-reads the pool under FOR UPDATE after
    # fetching it via get_by_event_tier (idx13 race guard). Mirror the locked
    # read onto whichever getter the test actually populated so existing mocks
    # keep working without per-test changes.
    async def _get_for_update(pool_id):  # noqa: ARG001
        if svc.pool_repo.get.return_value is not None:
            return svc.pool_repo.get.return_value
        return svc.pool_repo.get_by_event_tier.return_value

    svc.pool_repo.get_for_update = AsyncMock(side_effect=_get_for_update)
    # 응모는 공유 잠금(get_for_share)을 쓴다(과업 WP11) — 같은 목 동작을 그대로 비춘다.
    svc.pool_repo.get_for_share = AsyncMock(side_effect=_get_for_update)
    svc.entry_repo = AsyncMock()
    svc.tier_repo = AsyncMock()
    svc.ticket_repo = AsyncMock()
    svc.order_repo = AsyncMock()
    svc.fan_weight_service = AsyncMock()
    svc.pity_service = AsyncMock()
    svc.point_service = AsyncMock()
    svc.tier_service = AsyncMock()
    return svc


# ===========================================================================
# compute_group_ap_cost tests
# ===========================================================================

class TestComputeGroupApCost:
    def test_single_person(self):
        assert compute_group_ap_cost(1000, 1) == 1000

    def test_two_people(self):
        assert compute_group_ap_cost(1000, 2) == 1600

    def test_three_people(self):
        assert compute_group_ap_cost(1000, 3) == 2100

    def test_four_people(self):
        assert compute_group_ap_cost(1000, 4) == 2400

    def test_unknown_group_size_fallback(self):
        # group_size=5 not in dict → uses group_size * 0.6 multiplier
        result = compute_group_ap_cost(1000, 5)
        assert result == int(1000 * 5 * 0.6)

    def test_zero_ap(self):
        assert compute_group_ap_cost(0, 2) == 0


# ===========================================================================
# apply() tests
# ===========================================================================

class TestLotteryApply:

    @pytest.mark.asyncio
    async def test_apply_tier_not_found(self):
        svc = _build_service()
        svc.tier_repo.get.return_value = None

        with pytest.raises(ValueError, match="Tier .* not found"):
            await svc.apply(uuid.uuid4(), uuid.uuid4(), uuid.uuid4())

    @pytest.mark.asyncio
    async def test_apply_rejects_tier_from_another_event(self):
        """크로스이벤트 tier 주입 차단 — 이 가드에 회귀 커버리지가 없었다.

        tier UUID 는 전역 유일하지만 공개 라우트는 event 로 스코프된다. 바인딩을 확인하지
        않으면 호출자가 **타 이벤트의 tier** 를 주입해 pool/order/ticket 체인을 교차 생성할
        수 있다. event_repo 는 아예 조회되지 않아야 한다(가드가 그 전에 끊는다).
        """
        svc = _build_service()
        svc.tier_repo.get.return_value = _make_tier(event_id=uuid.uuid4())

        with patch("app.repositories.event_repo.EventRepository") as MockEventRepo:
            with pytest.raises(ValueError, match="Tier does not belong to event"):
                await svc.apply(uuid.uuid4(), uuid.uuid4(), uuid.uuid4())
            MockEventRepo.assert_not_called()

    @pytest.mark.asyncio
    async def test_apply_event_not_found(self):
        svc = _build_service()
        event_id = uuid.uuid4()
        svc.tier_repo.get.return_value = _make_tier(event_id=event_id)

        with patch("app.repositories.event_repo.EventRepository") as MockEventRepo:
            mock_repo = AsyncMock()
            mock_repo.get.return_value = None
            MockEventRepo.return_value = mock_repo

            with pytest.raises(ValueError, match="Event not found"):
                await svc.apply(uuid.uuid4(), event_id, uuid.uuid4())

    @pytest.mark.asyncio
    async def test_apply_event_not_accepting(self):
        """Event in DRAFT status should reject lottery applications."""
        from app.models.event import EventStatus

        svc = _build_service()
        event_id = uuid.uuid4()
        svc.tier_repo.get.return_value = _make_tier(event_id=event_id)

        event = MagicMock()
        event.status = EventStatus.DRAFT
        event.bidding_opens_at = None
        event.bidding_closes_at = None

        with patch("app.repositories.event_repo.EventRepository") as MockEventRepo:
            mock_repo = AsyncMock()
            mock_repo.get.return_value = event
            MockEventRepo.return_value = mock_repo

            with pytest.raises(ValueError, match="not accepting lottery applications"):
                await svc.apply(uuid.uuid4(), event_id, uuid.uuid4())

    @pytest.mark.asyncio
    async def test_apply_negative_ap(self):
        svc = _build_service()
        tier = _make_tier()
        svc.tier_repo.get.return_value = tier
        event = _make_event(event_id=uuid.uuid4())
        tier.event_id = event.id

        with patch("app.repositories.event_repo.EventRepository") as MockEventRepo:
            mock_repo = AsyncMock()
            mock_repo.get.return_value = event
            MockEventRepo.return_value = mock_repo

            with pytest.raises(ValueError, match="invested_ap must be >= 0"):
                await svc.apply(uuid.uuid4(), event.id, tier.id, invested_ap=-100)

    @pytest.mark.asyncio
    async def test_apply_ap_exceeds_max(self):
        svc = _build_service()
        tier = _make_tier()
        svc.tier_repo.get.return_value = tier
        event = _make_event()
        tier.event_id = event.id

        with patch("app.repositories.event_repo.EventRepository") as MockEventRepo:
            mock_repo = AsyncMock()
            mock_repo.get.return_value = event
            MockEventRepo.return_value = mock_repo

            with pytest.raises(ValueError, match="invested_ap must be <="):
                await svc.apply(uuid.uuid4(), event.id, tier.id, invested_ap=20000)

    @pytest.mark.asyncio
    async def test_apply_ap_below_minimum_when_investing(self):
        svc = _build_service()
        tier = _make_tier()
        svc.tier_repo.get.return_value = tier
        event = _make_event()
        tier.event_id = event.id

        with patch("app.repositories.event_repo.EventRepository") as MockEventRepo:
            mock_repo = AsyncMock()
            mock_repo.get.return_value = event
            MockEventRepo.return_value = mock_repo

            with pytest.raises(ValueError, match="invested_ap must be >= 100"):
                await svc.apply(uuid.uuid4(), event.id, tier.id, invested_ap=50)

    @pytest.mark.asyncio
    async def test_apply_ap_not_multiple_of_100(self):
        svc = _build_service()
        tier = _make_tier()
        svc.tier_repo.get.return_value = tier
        event = _make_event()
        tier.event_id = event.id

        with patch("app.repositories.event_repo.EventRepository") as MockEventRepo:
            mock_repo = AsyncMock()
            mock_repo.get.return_value = event
            MockEventRepo.return_value = mock_repo

            with pytest.raises(ValueError, match="multiples of 100"):
                await svc.apply(uuid.uuid4(), event.id, tier.id, invested_ap=150)

    @pytest.mark.asyncio
    async def test_apply_pool_closed(self):
        svc = _build_service()
        tier = _make_tier()
        svc.tier_repo.get.return_value = tier
        event = _make_event()
        tier.event_id = event.id
        pool = _make_pool(status=LotteryPoolStatus.CLOSED)
        svc.pool_repo.get_by_event_tier.return_value = pool

        with patch("app.repositories.event_repo.EventRepository") as MockEventRepo:
            mock_repo = AsyncMock()
            mock_repo.get.return_value = event
            MockEventRepo.return_value = mock_repo

            with pytest.raises(ValueError, match="no longer accepting"):
                await svc.apply(uuid.uuid4(), event.id, tier.id)

    @pytest.mark.asyncio
    async def test_apply_duplicate_entry(self):
        svc = _build_service()
        tier = _make_tier()
        svc.tier_repo.get.return_value = tier
        event = _make_event()
        tier.event_id = event.id
        pool = _make_pool(status=LotteryPoolStatus.OPEN)
        svc.pool_repo.get_by_event_tier.return_value = pool
        svc.entry_repo.get_user_entry.return_value = _make_entry()

        with patch("app.repositories.event_repo.EventRepository") as MockEventRepo:
            mock_repo = AsyncMock()
            mock_repo.get.return_value = event
            MockEventRepo.return_value = mock_repo

            with pytest.raises(ValueError, match="이미 이 등급에 응모했습니다"):
                await svc.apply(uuid.uuid4(), event.id, tier.id)

    @pytest.mark.asyncio
    async def test_apply_insufficient_ap(self):
        """AP deduction failure should raise ValueError."""
        svc = _build_service()
        tier = _make_tier()
        svc.tier_repo.get.return_value = tier
        event = _make_event()
        tier.event_id = event.id
        pool = _make_pool(status=LotteryPoolStatus.OPEN)
        svc.pool_repo.get_by_event_tier.return_value = pool
        svc.entry_repo.get_user_entry.return_value = None
        svc.fan_weight_service.compute_weight.return_value = 1.0
        svc.point_service.deduct.side_effect = ValueError("Insufficient AP balance")
        svc.tier_service.get_tier_multiplier.return_value = 1.0
        svc.pity_service.get_pity_bonus.return_value = 1.0

        with patch("app.repositories.event_repo.EventRepository") as MockEventRepo:
            mock_repo = AsyncMock()
            mock_repo.get.return_value = event
            MockEventRepo.return_value = mock_repo

            with pytest.raises(ValueError, match="AP 투자 실패"):
                await svc.apply(uuid.uuid4(), event.id, tier.id, invested_ap=500)

    @pytest.mark.asyncio
    async def test_apply_success_with_ap(self):
        """Successful apply with AP investment."""
        svc = _build_service()
        tier = _make_tier()
        svc.tier_repo.get.return_value = tier
        event = _make_event()
        tier.event_id = event.id
        pool = _make_pool(status=LotteryPoolStatus.OPEN)
        svc.pool_repo.get_by_event_tier.return_value = pool
        svc.entry_repo.get_user_entry.return_value = None
        svc.fan_weight_service.compute_weight.return_value = 2.5
        entry = _make_entry(invested_ap=500, fan_weight=2.5)
        svc.entry_repo.create.return_value = entry
        svc.tier_service.get_tier_multiplier.return_value = 1.0
        svc.pity_service.get_pity_bonus.return_value = 1.0
        svc._get_event_domain = AsyncMock(return_value="concert")

        with patch("app.repositories.event_repo.EventRepository") as MockEventRepo:
            mock_repo = AsyncMock()
            mock_repo.get.return_value = event
            MockEventRepo.return_value = mock_repo
            with patch("app.services.lottery_service.write_audit_log", new_callable=AsyncMock):
                result = await svc.apply(uuid.uuid4(), event.id, tier.id, invested_ap=500)

        assert result.fan_weight == 2.5
        svc.point_service.deduct.assert_called_once()

    @pytest.mark.asyncio
    async def test_apply_approved_event_auto_transitions(self):
        """APPROVED event within bidding window should auto-transition to BIDDING_OPEN."""
        from app.models.event import EventStatus

        svc = _build_service()
        tier = _make_tier()
        svc.tier_repo.get.return_value = tier

        event = MagicMock()
        event.id = uuid.uuid4()
        tier.event_id = event.id
        event.status = EventStatus.APPROVED
        event.bidding_opens_at = datetime.now(timezone.utc) - timedelta(hours=1)
        event.bidding_closes_at = datetime.now(timezone.utc) + timedelta(hours=24)
        event.category = "CONCERT"

        pool = _make_pool(status=LotteryPoolStatus.OPEN)
        svc.pool_repo.get_by_event_tier.return_value = pool
        svc.entry_repo.get_user_entry.return_value = None
        svc.fan_weight_service.compute_weight.return_value = 1.0
        entry = _make_entry()
        svc.entry_repo.create.return_value = entry
        svc.tier_service.get_tier_multiplier.return_value = 1.0
        svc.pity_service.get_pity_bonus.return_value = 1.0
        svc._get_event_domain = AsyncMock(return_value="concert")

        with patch("app.repositories.event_repo.EventRepository") as MockEventRepo:
            mock_repo = AsyncMock()
            mock_repo.get.return_value = event
            MockEventRepo.return_value = mock_repo
            with patch("app.services.lottery_service.write_audit_log", new_callable=AsyncMock):
                result = await svc.apply(uuid.uuid4(), event.id, tier.id)

        # Should have called session.execute for the status update
        svc.session.execute.assert_called()

    @pytest.mark.asyncio
    async def test_apply_approved_event_not_yet_open(self):
        """APPROVED event before bidding_opens_at should be rejected."""
        from app.models.event import EventStatus

        svc = _build_service()
        tier = _make_tier()
        svc.tier_repo.get.return_value = tier

        event = MagicMock()
        event.id = uuid.uuid4()
        tier.event_id = event.id
        event.status = EventStatus.APPROVED
        event.bidding_opens_at = datetime.now(timezone.utc) + timedelta(hours=2)
        event.bidding_closes_at = datetime.now(timezone.utc) + timedelta(hours=24)
        event.category = "CONCERT"

        with patch("app.repositories.event_repo.EventRepository") as MockEventRepo:
            mock_repo = AsyncMock()
            mock_repo.get.return_value = event
            MockEventRepo.return_value = mock_repo

            with pytest.raises(ValueError, match="Sales window not yet open"):
                await svc.apply(uuid.uuid4(), event.id, tier.id)


# ===========================================================================
# draw() tests
# ===========================================================================

class TestLotteryDraw:

    @pytest.mark.asyncio
    async def test_draw_pool_not_found(self):
        svc = _build_service()
        svc.pool_repo.get.return_value = None

        with pytest.raises(ValueError, match="not found"):
            await svc.draw(uuid.uuid4())

    @pytest.mark.asyncio
    async def test_draw_already_drawn(self):
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.DRAWN)
        svc.pool_repo.get.return_value = pool

        with pytest.raises(ValueError, match="already been drawn"):
            await svc.draw(pool.id)

    @pytest.mark.asyncio
    async def test_draw_empty_pool(self):
        """Drawing with zero entries should return 0 winners."""
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.OPEN)
        svc.pool_repo.get.return_value = pool
        svc.entry_repo.get_by_pool.return_value = []

        result = await svc.draw(pool.id)

        assert result.winners == 0
        assert result.waitlisted == 0
        assert pool.status == LotteryPoolStatus.DRAWN

    @pytest.mark.asyncio
    async def test_draw_with_guaranteed_winners(self):
        """Guaranteed ticket holders should win first, consuming seats."""
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.OPEN, total_seats=1)
        svc.pool_repo.get.return_value = pool

        user1 = uuid.uuid4()
        user2 = uuid.uuid4()
        entry1 = _make_entry(user_id=user1, group_size=1)
        entry2 = _make_entry(user_id=user2, group_size=1)
        svc.entry_repo.get_by_pool.return_value = [entry1, entry2]

        # user1 has guaranteed ticket, user2 does not
        async def has_guaranteed(uid, domain):
            return uid == user1
        svc.pity_service.has_guaranteed_ticket.side_effect = has_guaranteed
        svc.pity_service.use_guaranteed_ticket.return_value = None
        svc.pity_service.record_win.return_value = None
        svc.pity_service.record_loss.return_value = None

        tier = _make_tier(sale_mode="lottery")
        svc.tier_repo.get.return_value = tier
        svc.tier_repo.increment_sold.return_value = None

        order = MagicMock()
        order.id = uuid.uuid4()
        svc.order_repo.create.return_value = order
        svc.ticket_repo.create_batch.return_value = None

        # Mock _get_event_domain
        svc._get_event_domain = AsyncMock(return_value="concert")

        with patch("app.services.lottery_service.write_audit_log", new_callable=AsyncMock):
            with patch("app.services.lottery_service.run_lottery") as mock_run:
                # Since only 1 seat and user1 gets guaranteed, user2 goes to waitlist
                mock_result = MagicMock()
                mock_result.winners = []
                mock_result.waitlist = [str(user2)]
                mock_result.seed_used = 42
                mock_result.commitment_hash = "abc123"
                mock_result.verification_data = {}
                mock_run.return_value = mock_result

                result = await svc.draw(pool.id)

        assert result.winners == 1  # user1 guaranteed
        assert result.waitlisted == 1  # user2 waitlisted
        svc.pity_service.use_guaranteed_ticket.assert_called_once()

    @pytest.mark.asyncio
    async def test_draw_all_seats_consumed_by_guaranteed(self):
        """When guaranteed winners consume all seats, remaining entries are waitlisted."""
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.OPEN, total_seats=1)
        svc.pool_repo.get.return_value = pool

        user1 = uuid.uuid4()
        user2 = uuid.uuid4()
        entry1 = _make_entry(user_id=user1, group_size=1)
        entry2 = _make_entry(user_id=user2, group_size=1)
        svc.entry_repo.get_by_pool.return_value = [entry1, entry2]

        svc.pity_service.has_guaranteed_ticket.side_effect = [True, False]
        svc.pity_service.use_guaranteed_ticket.return_value = None
        svc.pity_service.record_win.return_value = None
        svc.pity_service.record_loss.return_value = None

        tier = _make_tier(sale_mode="lottery")
        svc.tier_repo.get.return_value = tier
        svc.tier_repo.increment_sold.return_value = None

        order = MagicMock()
        order.id = uuid.uuid4()
        svc.order_repo.create.return_value = order
        svc.ticket_repo.create_batch.return_value = None

        svc._get_event_domain = AsyncMock(return_value="concert")

        with patch("app.services.lottery_service.write_audit_log", new_callable=AsyncMock):
            result = await svc.draw(pool.id)

        # user1 = guaranteed winner, user2 = waitlisted (no seats left, no engine run)
        assert result.winners == 1
        assert result.waitlisted == 1
        assert entry2.result == LotteryEntryResult.WAITLISTED

    @pytest.mark.asyncio
    async def test_draw_point_lottery_uses_engine(self):
        """Point lottery should use E-S weighted sampling engine path."""
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.OPEN, total_seats=2)
        svc.pool_repo.get.return_value = pool

        user1 = uuid.uuid4()
        user2 = uuid.uuid4()
        entry1 = _make_entry(user_id=user1, invested_ap=500, group_size=1)
        entry2 = _make_entry(user_id=user2, invested_ap=300, group_size=1)
        svc.entry_repo.get_by_pool.return_value = [entry1, entry2]

        svc.pity_service.has_guaranteed_ticket.return_value = False
        svc.pity_service.record_win.return_value = None

        tier = _make_tier(sale_mode="point_lottery")
        svc.tier_repo.get.return_value = tier
        svc.tier_repo.increment_sold.return_value = None

        order = MagicMock()
        order.id = uuid.uuid4()
        svc.order_repo.create.return_value = order
        svc.ticket_repo.create_batch.return_value = None

        svc._get_event_domain = AsyncMock(return_value="concert")

        with patch("app.services.lottery_service.write_audit_log", new_callable=AsyncMock):
            with patch("app.services.lottery_service.run_lottery") as mock_run:
                mock_result = MagicMock()
                mock_result.winners = [str(user1), str(user2)]
                mock_result.waitlist = []
                mock_result.seed_used = 42
                mock_result.commitment_hash = "hash123"
                mock_result.verification_data = {"algorithm": "efraimidis_spirakis_weighted_sampling"}
                # commit-reveal v2 reveal 필드 (result_hash 바인딩에 사용)
                mock_result.server_seed = 424242
                mock_result.entries_digest = "d" * 64
                mock_run.return_value = mock_result

                result = await svc.draw(pool.id)

        assert result.winners == 2
        assert result.waitlisted == 0
        mock_run.assert_called_once()

    @pytest.mark.asyncio
    async def test_draw_ap_consolation_for_waitlisted(self):
        """Waitlisted users with invested AP should receive consolation (no full refund)."""
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.OPEN, total_seats=1)
        svc.pool_repo.get.return_value = pool

        user1 = uuid.uuid4()
        user2 = uuid.uuid4()
        entry1 = _make_entry(user_id=user1, invested_ap=0, group_size=1)
        entry2 = _make_entry(user_id=user2, invested_ap=1000, group_size=1)
        svc.entry_repo.get_by_pool.return_value = [entry1, entry2]

        svc.pity_service.has_guaranteed_ticket.return_value = False
        svc.pity_service.record_win.return_value = None
        svc.pity_service.record_loss.return_value = None

        tier = _make_tier(sale_mode="point_lottery")
        svc.tier_repo.get.return_value = tier
        svc.tier_repo.increment_sold.return_value = None

        order = MagicMock()
        order.id = uuid.uuid4()
        svc.order_repo.create.return_value = order
        svc.ticket_repo.create_batch.return_value = None

        svc._get_event_domain = AsyncMock(return_value="concert")

        with patch("app.services.lottery_service.write_audit_log", new_callable=AsyncMock):
            with patch("app.services.lottery_service.run_lottery") as mock_run:
                mock_result = MagicMock()
                mock_result.winners = [str(user1)]
                mock_result.waitlist = [str(user2)]
                mock_result.seed_used = 42
                mock_result.commitment_hash = "hash123"
                mock_result.verification_data = {}
                mock_run.return_value = mock_result

                result = await svc.draw(pool.id)

        assert result.winners == 1
        assert result.waitlisted == 1
        # point_service.earn should be called once for user2: consolation only (no full refund)
        assert svc.point_service.earn.call_count == 1

    @pytest.mark.asyncio
    async def test_draw_winner_ap_fully_consumed(self):
        """Winners' invested AP should be fully consumed (no refund, VCG removed)."""
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.OPEN, total_seats=1)
        svc.pool_repo.get.return_value = pool

        user1 = uuid.uuid4()
        entry1 = _make_entry(user_id=user1, invested_ap=1000, group_size=1)
        svc.entry_repo.get_by_pool.return_value = [entry1]

        svc.pity_service.has_guaranteed_ticket.return_value = False
        svc.pity_service.record_win.return_value = None

        tier = _make_tier(sale_mode="point_lottery")
        svc.tier_repo.get.return_value = tier
        svc.tier_repo.increment_sold.return_value = None

        order = MagicMock()
        order.id = uuid.uuid4()
        svc.order_repo.create.return_value = order
        svc.ticket_repo.create_batch.return_value = None

        svc._get_event_domain = AsyncMock(return_value="concert")

        with patch("app.services.lottery_service.write_audit_log", new_callable=AsyncMock):
            with patch("app.services.lottery_service.run_lottery") as mock_run:
                mock_result = MagicMock()
                mock_result.winners = [str(user1)]
                mock_result.waitlist = []
                mock_result.seed_used = 42
                mock_result.commitment_hash = "hash123"
                mock_result.verification_data = {}
                mock_run.return_value = mock_result

                result = await svc.draw(pool.id)

        assert result.winners == 1
        # Winners' AP is fully consumed — no earn/refund calls
        svc.point_service.earn.assert_not_called()

    @pytest.mark.asyncio
    async def test_draw_pity_record_failure_does_not_crash(self):
        """Pity service failures should be logged but not crash the draw."""
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.OPEN, total_seats=10)
        svc.pool_repo.get.return_value = pool

        user1 = uuid.uuid4()
        entry1 = _make_entry(user_id=user1, group_size=1)
        svc.entry_repo.get_by_pool.return_value = [entry1]

        svc.pity_service.has_guaranteed_ticket.return_value = False
        svc.pity_service.record_win.side_effect = Exception("pity DB error")

        tier = _make_tier(sale_mode="lottery")
        svc.tier_repo.get.return_value = tier
        svc.tier_repo.increment_sold.return_value = None

        order = MagicMock()
        order.id = uuid.uuid4()
        svc.order_repo.create.return_value = order
        svc.ticket_repo.create_batch.return_value = None

        svc._get_event_domain = AsyncMock(return_value="concert")

        with patch("app.services.lottery_service.write_audit_log", new_callable=AsyncMock):
            with patch("app.services.lottery_service.run_lottery") as mock_run:
                mock_result = MagicMock()
                mock_result.winners = [str(user1)]
                mock_result.waitlist = []
                mock_result.seed_used = 99
                mock_result.commitment_hash = "hash"
                mock_result.verification_data = {}
                mock_run.return_value = mock_result

                result = await svc.draw(pool.id)

        # Should succeed despite pity failure
        assert result.winners == 1


# ===========================================================================
# verify_pool() tests
# ===========================================================================

class TestVerifyPool:

    @pytest.mark.asyncio
    async def test_verify_pool_not_found(self):
        svc = _build_service()
        svc.pool_repo.get.return_value = None

        with pytest.raises(ValueError, match="not found"):
            await svc.verify_pool(uuid.uuid4())

    @pytest.mark.asyncio
    async def test_verify_pool_not_drawn(self):
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.OPEN)
        svc.pool_repo.get.return_value = pool

        with pytest.raises(ValueError, match="not been drawn"):
            await svc.verify_pool(pool.id)

    @pytest.mark.asyncio
    async def test_verify_vcg_pool(self):
        svc = _build_service()
        pool = _make_pool(
            status=LotteryPoolStatus.DRAWN,
            verification_data={"algorithm": "vcg_weighted_allocation", "is_strategy_proof": True},
            commitment_hash="",
            seed_used=0,
        )
        svc.pool_repo.get.return_value = pool
        svc.entry_repo.count_by_pool.return_value = 5

        result = await svc.verify_pool(pool.id)

        assert result.is_valid is True
        assert result.algorithm == "vcg_weighted_allocation"

    @pytest.mark.asyncio
    async def test_verify_standard_pool_with_commitment(self):
        svc = _build_service()
        pool = _make_pool(
            status=LotteryPoolStatus.DRAWN,
            verification_data={"some": "data"},
            commitment_hash="abc123hash",
            seed_used=42,
        )
        svc.pool_repo.get.return_value = pool
        svc.entry_repo.count_by_pool.return_value = 3

        with patch("app.services.lottery_service.LotteryVerifier") as MockVerifier:
            MockVerifier.verify.return_value = True
            result = await svc.verify_pool(pool.id)

        assert result.is_valid is True
        assert result.seed_used == 42

    @pytest.mark.asyncio
    async def test_verify_pool_no_verification_data(self):
        svc = _build_service()
        pool = _make_pool(
            status=LotteryPoolStatus.DRAWN,
            verification_data=None,
            commitment_hash=None,
            seed_used=None,
        )
        svc.pool_repo.get.return_value = pool
        svc.entry_repo.count_by_pool.return_value = 2

        result = await svc.verify_pool(pool.id)

        assert result.is_valid is False


# ===========================================================================
# get_transparency_report() tests
# ===========================================================================

class TestTransparencyReport:

    @pytest.mark.asyncio
    async def test_report_pool_not_found(self):
        svc = _build_service()
        svc.pool_repo.get.return_value = None

        with pytest.raises(ValueError, match="not found"):
            await svc.get_transparency_report(uuid.uuid4())

    @pytest.mark.asyncio
    async def test_report_not_drawn(self):
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.OPEN)
        svc.pool_repo.get.return_value = pool

        with pytest.raises(ValueError, match="not been drawn"):
            await svc.get_transparency_report(pool.id)

    @pytest.mark.asyncio
    async def test_report_empty_entries(self):
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.DRAWN, total_seats=10, verification_data={})
        svc.pool_repo.get.return_value = pool
        svc.entry_repo.get_by_pool.return_value = []

        result = await svc.get_transparency_report(pool.id)

        assert result.total_applicants == 0
        assert result.competition_ratio == 0.0
        assert result.weight_distribution["min"] == 0

    @pytest.mark.asyncio
    async def test_report_with_entries(self):
        svc = _build_service()
        pool = _make_pool(
            status=LotteryPoolStatus.DRAWN,
            total_seats=10,
            verification_data={},
            commitment_hash="hash123",
        )
        svc.pool_repo.get.return_value = pool

        entries = [
            _make_entry(fan_weight=1.5, result=LotteryEntryResult.WON),
            _make_entry(fan_weight=2.0, result=LotteryEntryResult.WON),
            _make_entry(fan_weight=3.0, result=LotteryEntryResult.WAITLISTED),
        ]
        svc.entry_repo.get_by_pool.return_value = entries

        result = await svc.get_transparency_report(pool.id)

        assert result.total_applicants == 3
        assert result.competition_ratio == 0.3
        assert result.pool_breakdown["won"] == 2
        assert result.pool_breakdown["waitlisted"] == 1
        assert result.weight_distribution["min"] == 1.5
        assert result.weight_distribution["max"] == 3.0

    @pytest.mark.asyncio
    async def test_report_vcg_includes_fairness_metrics(self):
        svc = _build_service()
        pool = _make_pool(
            status=LotteryPoolStatus.DRAWN,
            total_seats=5,
            verification_data={
                "algorithm": "vcg_weighted_allocation",
                "is_strategy_proof": True,
                "fairness_metrics": {
                    "gini_coefficient": 0.15,
                    "theil_index": 0.02,
                    "atkinson_index": 0.01,
                    "entropy_fairness": 0.98,
                    "weight_price_correlation": 0.3,
                },
                "consumer_metrics": {
                    "total_consumer_surplus": 250.0,
                    "avg_surplus_ratio": 0.6,
                },
            },
        )
        svc.pool_repo.get.return_value = pool

        entries = [_make_entry(fan_weight=2.0, result=LotteryEntryResult.WON)]
        svc.entry_repo.get_by_pool.return_value = entries

        result = await svc.get_transparency_report(pool.id)

        assert result.algorithm == "vcg_weighted_allocation"
        assert result.weight_distribution["gini_coefficient"] == 0.15
        assert result.weight_distribution["is_strategy_proof"] is True
        assert result.weight_distribution["total_consumer_surplus"] == 250.0

    @pytest.mark.asyncio
    async def test_report_zero_total_seats(self):
        """Zero total_seats should not cause division by zero."""
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.DRAWN, total_seats=0, verification_data={})
        svc.pool_repo.get.return_value = pool
        svc.entry_repo.get_by_pool.return_value = []

        result = await svc.get_transparency_report(pool.id)
        assert result.competition_ratio == 0.0


# ===========================================================================
# get_my_result() tests
# ===========================================================================

class TestGetMyResult:

    @pytest.mark.asyncio
    async def test_my_result_pool_not_found(self):
        svc = _build_service()
        svc.pool_repo.get.return_value = None

        with pytest.raises(ValueError, match="not found"):
            await svc.get_my_result(uuid.uuid4(), uuid.uuid4())

    @pytest.mark.asyncio
    async def test_my_result_not_drawn(self):
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.OPEN)
        svc.pool_repo.get.return_value = pool

        with pytest.raises(ValueError, match="not been drawn"):
            await svc.get_my_result(pool.id, uuid.uuid4())

    @pytest.mark.asyncio
    async def test_my_result_no_entry(self):
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.DRAWN)
        svc.pool_repo.get.return_value = pool
        svc.entry_repo.get_user_entry.return_value = None

        with pytest.raises(ValueError, match="no entry"):
            await svc.get_my_result(pool.id, uuid.uuid4())

    @pytest.mark.asyncio
    async def test_my_result_success(self):
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.DRAWN)
        user_id = uuid.uuid4()
        entry = _make_entry(user_id=user_id, fan_weight=2.5, result=LotteryEntryResult.WON, invested_ap=500)
        svc.pool_repo.get.return_value = pool
        svc.entry_repo.get_user_entry.return_value = entry
        svc.entry_repo.get_by_pool.return_value = [
            _make_entry(fan_weight=2.5),
            _make_entry(fan_weight=3.0),
        ]

        # Mock user repo (imported locally inside get_my_result)
        with patch("app.repositories.user_repo.UserRepository") as MockUserRepo:
            mock_user = MagicMock()
            mock_user_repo = AsyncMock()
            mock_user_repo.get.return_value = mock_user
            MockUserRepo.return_value = mock_user_repo

            scores = MagicMock()
            scores.loyalty = 0.8
            scores.history = 0.6
            scores.fanclub = 0.0
            scores.behavior = 0.9
            scores.freshness = 0.7
            svc.fan_weight_service.build_fan_scores.return_value = scores

            result = await svc.get_my_result(pool.id, user_id)

        assert result.result == "won"
        assert result.fan_weight == 2.5
        assert result.invested_ap == 500
        assert result.pool_stats["total_applicants"] == 2
        assert "verify" in result.verification_link

    @pytest.mark.asyncio
    async def test_my_result_weight_breakdown_failure(self):
        """If weight breakdown computation fails, it should return empty dict."""
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.DRAWN)
        user_id = uuid.uuid4()
        entry = _make_entry(user_id=user_id, fan_weight=1.0, result=LotteryEntryResult.WAITLISTED)
        svc.pool_repo.get.return_value = pool
        svc.entry_repo.get_user_entry.return_value = entry
        svc.entry_repo.get_by_pool.return_value = [_make_entry(fan_weight=1.0)]

        with patch("app.repositories.user_repo.UserRepository") as MockUserRepo:
            MockUserRepo.side_effect = Exception("import error")

            result = await svc.get_my_result(pool.id, user_id)

        assert result.weight_breakdown == {}

    @pytest.mark.asyncio
    async def test_my_result_user_not_found_in_repo(self):
        """If user is not found in repo, weight_breakdown should be empty."""
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.DRAWN)
        user_id = uuid.uuid4()
        entry = _make_entry(user_id=user_id, fan_weight=1.0, result=LotteryEntryResult.WON)
        svc.pool_repo.get.return_value = pool
        svc.entry_repo.get_user_entry.return_value = entry
        svc.entry_repo.get_by_pool.return_value = [_make_entry(fan_weight=1.0)]

        with patch("app.repositories.user_repo.UserRepository") as MockUserRepo:
            mock_user_repo = AsyncMock()
            mock_user_repo.get.return_value = None
            MockUserRepo.return_value = mock_user_repo

            result = await svc.get_my_result(pool.id, user_id)

        assert result.weight_breakdown == {}


# ===========================================================================
# get_pool_status() tests
# ===========================================================================

class TestGetPoolStatus:

    @pytest.mark.asyncio
    async def test_pool_status_not_found(self):
        svc = _build_service()
        svc.pool_repo.get_by_event_tier.return_value = None

        with pytest.raises(ValueError, match="No lottery pool found"):
            await svc.get_pool_status(uuid.uuid4(), uuid.uuid4())

    @pytest.mark.asyncio
    async def test_pool_status_success(self):
        svc = _build_service()
        pool = _make_pool(status=LotteryPoolStatus.OPEN, total_seats=10, seed_used=None)
        svc.pool_repo.get_by_event_tier.return_value = pool
        svc.entry_repo.count_by_pool.return_value = 5

        result = await svc.get_pool_status(pool.event_id, pool.tier_id)

        assert result.total_seats == 10
        assert result.total_applicants == 5
        assert result.status == "open"


# ===========================================================================
# _apply_newcomer_shield() tests
# ===========================================================================

class TestNewcomerShield:

    @pytest.mark.asyncio
    async def test_newcomer_user_not_found(self):
        svc = _build_service()
        svc.session.execute = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        svc.session.execute.return_value = mock_result

        result = await svc._apply_newcomer_shield(uuid.uuid4(), 1.0)
        assert result is False

    @pytest.mark.asyncio
    async def test_newcomer_old_user(self):
        """User created > 30 days ago should not get shield."""
        svc = _build_service()
        user = MagicMock()
        user.created_at = datetime.now(timezone.utc) - timedelta(days=60)
        user.avatar_url = "https://example.com/avatar.png"
        user.bio = "test"
        user.newcomer_uses_remaining = 3

        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = user
        svc.session.execute = AsyncMock(return_value=mock_result)

        result = await svc._apply_newcomer_shield(uuid.uuid4(), 1.0)
        assert result is False

    @pytest.mark.asyncio
    async def test_newcomer_no_profile(self):
        """User without avatar/bio should not get shield."""
        svc = _build_service()
        user = MagicMock()
        user.created_at = datetime.now(timezone.utc) - timedelta(days=5)
        user.avatar_url = None
        user.bio = None
        user.newcomer_uses_remaining = 3

        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = user
        svc.session.execute = AsyncMock(return_value=mock_result)

        result = await svc._apply_newcomer_shield(uuid.uuid4(), 1.0)
        assert result is False

    @pytest.mark.asyncio
    async def test_newcomer_no_uses_remaining(self):
        svc = _build_service()
        user = MagicMock()
        user.created_at = datetime.now(timezone.utc) - timedelta(days=5)
        user.avatar_url = "https://example.com/avatar.png"
        user.bio = "test"
        user.newcomer_uses_remaining = 0

        # execute() #1 → SELECT User (returns user); #2 → guarded UPDATE RETURNING.
        # With remaining=0 the guarded UPDATE matches 0 rows → returning None.
        select_result = MagicMock()
        select_result.scalar_one_or_none.return_value = user
        update_result = MagicMock()
        update_result.scalar_one_or_none.return_value = None
        svc.session.execute = AsyncMock(side_effect=[select_result, update_result])

        result = await svc._apply_newcomer_shield(uuid.uuid4(), 1.0)
        assert result is False

    @pytest.mark.asyncio
    async def test_newcomer_shield_applied(self):
        """Eligible newcomer should get shield and decrement uses."""
        svc = _build_service()
        user = MagicMock()
        user.created_at = datetime.now(timezone.utc) - timedelta(days=5)
        user.avatar_url = "https://example.com/avatar.png"
        user.bio = "test bio"
        user.newcomer_uses_remaining = 3

        # execute() #1 → SELECT User; #2 → guarded UPDATE RETURNING new remaining (2).
        select_result = MagicMock()
        select_result.scalar_one_or_none.return_value = user
        update_result = MagicMock()
        update_result.scalar_one_or_none.return_value = 2
        svc.session.execute = AsyncMock(side_effect=[select_result, update_result])
        svc.session.flush = AsyncMock()
        svc.session.refresh = AsyncMock()

        result = await svc._apply_newcomer_shield(uuid.uuid4(), 1.0)

        assert result is True

    @pytest.mark.asyncio
    async def test_newcomer_naive_datetime_handled(self):
        """created_at without tzinfo should be treated as UTC."""
        svc = _build_service()
        user = MagicMock()
        # naive datetime (no tzinfo)
        user.created_at = datetime.now() - timedelta(days=5)
        user.avatar_url = "https://example.com/avatar.png"
        user.bio = "bio"
        user.newcomer_uses_remaining = 2

        select_result = MagicMock()
        select_result.scalar_one_or_none.return_value = user
        update_result = MagicMock()
        update_result.scalar_one_or_none.return_value = 1
        svc.session.execute = AsyncMock(side_effect=[select_result, update_result])
        svc.session.flush = AsyncMock()
        svc.session.refresh = AsyncMock()

        result = await svc._apply_newcomer_shield(uuid.uuid4(), 1.0)
        assert result is True
