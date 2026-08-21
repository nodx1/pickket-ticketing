"""Tests for WP14-18: Gamification, Newcomer Shield, Group AP, Genre Supporter.

Test coverage:
- test_quest_completion: Quest completion + AP reward
- test_quest_dedup: Duplicate quest completion blocked within same period
- test_attendance_streak: Daily check-in + weekly streak bonus
- test_newcomer_shield: 30-day window, profile completion, 3-use limit, 1.5x boost
- test_group_ap_discount: Group AP cost calculation accuracy
- test_genre_supporter: 3 attendances -> qualification + 500 AP
- test_badge_award: Badge condition check and automatic awarding
- test_quest_api_endpoints: API endpoint smoke tests
"""

from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.tests.conftest import (
    TestSession,
    auth_headers,
    get_auth_token,
)
from app.models.user import User
from app.models.quest import Quest, QuestType
from app.models.badge import Badge
from app.models.attendance_record import AttendanceRecord
from app.models.point import PointWallet, PointTransaction, PointType, PointTransactionType
from app.services.quest_service import QuestService
from app.services.badge_service import BadgeService
from app.services.attendance_service import AttendanceService, DAILY_CHECKIN_AP
from app.services.genre_supporter_service import (
    GenreSupporterService,
    GENRE_SUPPORTER_THRESHOLD,
    GENRE_SUPPORTER_AP_REWARD,
)
from app.services.lottery_service import compute_group_ap_cost


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_user_with_wallet(session: AsyncSession, email: str = "quest@test.com") -> User:
    """Create a test user with point wallets directly in the DB."""
    user = User(
        email=email,
        hashed_password="$2b$12$test_hashed_password_placeholder",
        name="Test User",
        is_verified=True,
    )
    session.add(user)
    await session.flush()

    # Create wallets
    for pt in [PointType.FAN, PointType.SOCIAL]:
        wallet = PointWallet(
            user_id=user.id,
            point_type=pt,
            balance=100,
            lifetime_earned=100,
        )
        session.add(wallet)
        await session.flush()

        tx = PointTransaction(
            wallet_id=wallet.id,
            user_id=user.id,
            tx_type=PointTransactionType.EARN_SIGNUP,
            amount=100,
            balance_after=100,
            description="test signup bonus",
        )
        session.add(tx)

    await session.flush()
    return user


async def _create_quest(
    session: AsyncSession,
    quest_type: QuestType = QuestType.DAILY,
    title: str = "Test Quest",
    ap_reward: int = 20,
    condition_type: str = "checkin",
    condition_count: int = 1,
) -> Quest:
    """Create a test quest directly in the DB."""
    quest = Quest(
        quest_type=quest_type,
        title=title,
        ap_reward=ap_reward,
        condition_type=condition_type,
        condition_count=condition_count,
        is_active=True,
    )
    session.add(quest)
    await session.flush()
    return quest


# ---------------------------------------------------------------------------
# WP14: Quest Completion Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_quest_completion(db_session: AsyncSession):
    """Quest completion should award AP and create completion record."""
    user = await _create_user_with_wallet(db_session, "qc@test.com")
    quest = await _create_quest(db_session, ap_reward=25)
    await db_session.commit()

    async with TestSession() as session:
        svc = QuestService(session)
        completion = await svc.complete_quest(user.id, quest.id)
        await session.commit()

        assert completion.ap_awarded == 25
        assert completion.user_id == user.id
        assert completion.quest_id == quest.id

    # Verify AP was credited
    async with TestSession() as session:
        result = await session.execute(
            select(PointWallet).where(
                PointWallet.user_id == user.id,
                PointWallet.point_type == PointType.FAN,
            )
        )
        wallet = result.scalar_one()
        assert wallet.balance == 125  # 100 signup + 25 quest reward


@pytest.mark.asyncio
async def test_quest_dedup(db_session: AsyncSession):
    """Same quest cannot be completed twice in the same period."""
    user = await _create_user_with_wallet(db_session, "dedup@test.com")
    quest = await _create_quest(db_session, quest_type=QuestType.DAILY, ap_reward=10)
    await db_session.commit()

    # First completion should succeed
    async with TestSession() as session:
        svc = QuestService(session)
        await svc.complete_quest(user.id, quest.id)
        await session.commit()

    # Second completion same day should fail
    async with TestSession() as session:
        svc = QuestService(session)
        with pytest.raises(ValueError, match="이미 완료한 퀘스트"):
            await svc.complete_quest(user.id, quest.id)


@pytest.mark.asyncio
async def test_quest_milestone_one_time(db_session: AsyncSession):
    """Milestone quests can only be completed once (period_key='')."""
    user = await _create_user_with_wallet(db_session, "milestone@test.com")
    quest = await _create_quest(
        db_session,
        quest_type=QuestType.MILESTONE,
        title="First Ticket Purchase",
        ap_reward=50,
    )
    await db_session.commit()

    # First completion
    async with TestSession() as session:
        svc = QuestService(session)
        completion = await svc.complete_quest(user.id, quest.id)
        await session.commit()
        assert completion.period_key == ""

    # Second attempt should fail
    async with TestSession() as session:
        svc = QuestService(session)
        with pytest.raises(ValueError, match="이미 완료한 퀘스트"):
            await svc.complete_quest(user.id, quest.id)


# ---------------------------------------------------------------------------
# WP14: Attendance Streak Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_attendance_streak(db_session: AsyncSession):
    """Daily check-in should award AP and update streak."""
    user = await _create_user_with_wallet(db_session, "streak@test.com")
    await db_session.commit()

    async with TestSession() as session:
        svc = AttendanceService(session)
        result = await svc.check_in(user.id, source="manual")
        await session.commit()

        assert result["daily_ap"] == DAILY_CHECKIN_AP
        assert result["current_week_days"] == 1
        assert result["consecutive_weeks"] == 0

    # Verify AP credited
    async with TestSession() as session:
        wallet_result = await session.execute(
            select(PointWallet).where(
                PointWallet.user_id == user.id,
                PointWallet.point_type == PointType.FAN,
            )
        )
        wallet = wallet_result.scalar_one()
        assert wallet.balance == 100 + DAILY_CHECKIN_AP


@pytest.mark.asyncio
async def test_attendance_dedup(db_session: AsyncSession):
    """Cannot check in twice on the same day."""
    user = await _create_user_with_wallet(db_session, "dup_checkin@test.com")
    await db_session.commit()

    async with TestSession() as session:
        svc = AttendanceService(session)
        await svc.check_in(user.id)
        await session.commit()

    async with TestSession() as session:
        svc = AttendanceService(session)
        with pytest.raises(ValueError, match="이미 출석 체크"):
            await svc.check_in(user.id)


@pytest.mark.asyncio
async def test_attendance_streak_info(db_session: AsyncSession):
    """get_streak returns correct info."""
    user = await _create_user_with_wallet(db_session, "info@test.com")
    await db_session.commit()

    async with TestSession() as session:
        svc = AttendanceService(session)
        # Check in once
        await svc.check_in(user.id)
        await session.commit()

    async with TestSession() as session:
        svc = AttendanceService(session)
        streak = await svc.get_streak(user.id)
        assert streak["current_week_days"] == 1
        assert streak["rescue_remaining"] == 3
        assert streak["monthly_attendance_count"] >= 1


# ---------------------------------------------------------------------------
# WP14: Badge Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_badge_award(db_session: AsyncSession):
    """Badge is awarded when condition is met."""
    user = await _create_user_with_wallet(db_session, "badge@test.com")

    badge = Badge(
        name="First Check-in",
        description="Complete your first daily check-in",
        category="milestone",
        condition_type="attendance_count",
        condition_value=1,
    )
    db_session.add(badge)
    await db_session.flush()

    # Create an attendance record to satisfy condition
    record = AttendanceRecord(
        user_id=user.id,
        checked_date=date.today(),
        source="manual",
    )
    db_session.add(record)
    await db_session.commit()

    async with TestSession() as session:
        svc = BadgeService(session)
        newly_awarded = await svc.check_and_award_badges(user.id)
        await session.commit()
        assert len(newly_awarded) == 1

    # Check user has badge
    async with TestSession() as session:
        svc = BadgeService(session)
        badges = await svc.get_user_badges(user.id)
        assert len(badges) == 1
        assert badges[0]["name"] == "First Check-in"


@pytest.mark.asyncio
async def test_badge_no_duplicate(db_session: AsyncSession):
    """Badge is not awarded twice."""
    user = await _create_user_with_wallet(db_session, "badgedup@test.com")

    badge = Badge(
        name="Attendance Badge",
        category="milestone",
        condition_type="attendance_count",
        condition_value=1,
    )
    db_session.add(badge)

    record = AttendanceRecord(
        user_id=user.id,
        checked_date=date.today(),
        source="manual",
    )
    db_session.add(record)
    await db_session.commit()

    async with TestSession() as session:
        svc = BadgeService(session)
        first = await svc.check_and_award_badges(user.id)
        await session.commit()
        assert len(first) == 1

    async with TestSession() as session:
        svc = BadgeService(session)
        second = await svc.check_and_award_badges(user.id)
        await session.commit()
        assert len(second) == 0  # No new badges


# ---------------------------------------------------------------------------
# WP16: Newcomer Shield Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_newcomer_shield(db_session: AsyncSession):
    """Newcomer shield: 1.5x boost within 30 days, with profile, max 3 uses."""
    # Create a new user (created_at = now, within 30 days)
    user = User(
        email="newcomer@test.com",
        hashed_password="$2b$12$test_hashed_password_placeholder",
        name="New User",
        is_verified=True,
        avatar_url="https://example.com/avatar.jpg",  # Profile completed
        newcomer_uses_remaining=3,
        created_at=datetime.now(timezone.utc),
    )
    db_session.add(user)
    await db_session.flush()
    await db_session.commit()

    async with TestSession() as session:
        from app.services.lottery_service import LotteryService

        svc = LotteryService(session)
        applied = await svc._apply_newcomer_shield(user.id, 1.0)
        await session.commit()
        assert applied is True

    # Check uses remaining decreased
    async with TestSession() as session:
        result = await session.execute(select(User).where(User.id == user.id))
        u = result.scalar_one()
        assert u.newcomer_uses_remaining == 2


@pytest.mark.asyncio
async def test_newcomer_shield_no_profile(db_session: AsyncSession):
    """Newcomer shield not applied when profile is incomplete."""
    user = User(
        email="noprofile@test.com",
        hashed_password="$2b$12$test_hashed_password_placeholder",
        name="No Profile User",
        is_verified=True,
        avatar_url=None,
        bio=None,
        newcomer_uses_remaining=3,
        created_at=datetime.now(timezone.utc),
    )
    db_session.add(user)
    await db_session.flush()
    await db_session.commit()

    async with TestSession() as session:
        from app.services.lottery_service import LotteryService

        svc = LotteryService(session)
        applied = await svc._apply_newcomer_shield(user.id, 1.0)
        assert applied is False


@pytest.mark.asyncio
async def test_newcomer_shield_expired(db_session: AsyncSession):
    """Newcomer shield not applied after 30 days."""
    user = User(
        email="expired@test.com",
        hashed_password="$2b$12$test_hashed_password_placeholder",
        name="Old User",
        is_verified=True,
        avatar_url="https://example.com/avatar.jpg",
        newcomer_uses_remaining=3,
        created_at=datetime.now(timezone.utc) - timedelta(days=31),
    )
    db_session.add(user)
    await db_session.flush()
    await db_session.commit()

    async with TestSession() as session:
        from app.services.lottery_service import LotteryService

        svc = LotteryService(session)
        applied = await svc._apply_newcomer_shield(user.id, 1.0)
        assert applied is False


@pytest.mark.asyncio
async def test_newcomer_shield_uses_exhausted(db_session: AsyncSession):
    """Newcomer shield not applied when uses are exhausted."""
    user = User(
        email="exhausted@test.com",
        hashed_password="$2b$12$test_hashed_password_placeholder",
        name="Exhausted User",
        is_verified=True,
        avatar_url="https://example.com/avatar.jpg",
        newcomer_uses_remaining=0,
        created_at=datetime.now(timezone.utc),
    )
    db_session.add(user)
    await db_session.flush()
    await db_session.commit()

    async with TestSession() as session:
        from app.services.lottery_service import LotteryService

        svc = LotteryService(session)
        applied = await svc._apply_newcomer_shield(user.id, 1.0)
        assert applied is False


# ---------------------------------------------------------------------------
# WP17: Group AP Discount Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_group_ap_discount():
    """Group AP cost calculation matches expected multipliers."""
    # Solo: no discount
    assert compute_group_ap_cost(100, 1) == 100

    # Group of 2: 1.6x total (instead of 2x)
    assert compute_group_ap_cost(100, 2) == 160

    # Group of 3: 2.1x total (instead of 3x)
    assert compute_group_ap_cost(100, 3) == 210

    # Group of 4: 2.4x total (instead of 4x)
    assert compute_group_ap_cost(100, 4) == 240


@pytest.mark.asyncio
async def test_group_ap_discount_fallback():
    """Group AP cost uses fallback multiplier for group sizes > 4."""
    # Group of 5: 5 * 0.6 = 3.0x
    assert compute_group_ap_cost(100, 5) == 300

    # Group of 6: 6 * 0.6 = 3.6x (int rounding)
    assert compute_group_ap_cost(100, 6) in (359, 360)


@pytest.mark.asyncio
async def test_group_ap_discount_savings():
    """Per-person cost decreases as group size increases."""
    per_person_costs = {}
    for size in range(1, 5):
        total = compute_group_ap_cost(100, size)
        per_person_costs[size] = total / size

    # Per-person cost should decrease with larger groups
    assert per_person_costs[2] < per_person_costs[1]
    assert per_person_costs[3] < per_person_costs[2]
    assert per_person_costs[4] < per_person_costs[3]


# ---------------------------------------------------------------------------
# WP18: Genre Supporter Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_genre_supporter(db_session: AsyncSession):
    """3 attendances in a domain -> genre supporter + 500 AP."""
    user = await _create_user_with_wallet(db_session, "genre@test.com")
    await db_session.commit()

    async with TestSession() as session:
        svc = GenreSupporterService(session)

        # First 2 attendances: not yet qualified
        for i in range(GENRE_SUPPORTER_THRESHOLD - 1):
            supporter = await svc.record_attendance(user.id, "musical")
            assert supporter.is_qualified is False
        await session.commit()

    async with TestSession() as session:
        svc = GenreSupporterService(session)
        # 3rd attendance: qualification trigger
        supporter = await svc.record_attendance(user.id, "musical")
        await session.commit()
        assert supporter.is_qualified is True
        assert supporter.ap_rewarded is True
        assert supporter.attendance_count == GENRE_SUPPORTER_THRESHOLD

    # Verify 500 AP was credited
    async with TestSession() as session:
        wallet_result = await session.execute(
            select(PointWallet).where(
                PointWallet.user_id == user.id,
                PointWallet.point_type == PointType.FAN,
            )
        )
        wallet = wallet_result.scalar_one()
        assert wallet.balance == 100 + GENRE_SUPPORTER_AP_REWARD


@pytest.mark.asyncio
async def test_genre_supporter_is_supporter(db_session: AsyncSession):
    """is_supporter returns correct status."""
    user = await _create_user_with_wallet(db_session, "supporter@test.com")
    await db_session.commit()

    async with TestSession() as session:
        svc = GenreSupporterService(session)
        # Before qualification
        assert await svc.is_supporter(user.id, "classical") is False

        # Record 3 attendances
        for _ in range(GENRE_SUPPORTER_THRESHOLD):
            await svc.record_attendance(user.id, "classical")
        await session.commit()

    async with TestSession() as session:
        svc = GenreSupporterService(session)
        assert await svc.is_supporter(user.id, "classical") is True
        assert await svc.is_supporter(user.id, "sports") is False  # Different domain


@pytest.mark.asyncio
async def test_genre_supporter_no_double_reward(db_session: AsyncSession):
    """Additional attendances after qualification don't award extra AP."""
    user = await _create_user_with_wallet(db_session, "double@test.com")
    await db_session.commit()

    async with TestSession() as session:
        svc = GenreSupporterService(session)
        # Qualify
        for _ in range(GENRE_SUPPORTER_THRESHOLD):
            await svc.record_attendance(user.id, "sports")
        await session.commit()

    async with TestSession() as session:
        svc = GenreSupporterService(session)
        # 4th attendance: should not award again
        supporter = await svc.record_attendance(user.id, "sports")
        await session.commit()
        assert supporter.attendance_count == GENRE_SUPPORTER_THRESHOLD + 1
        assert supporter.ap_rewarded is True

    # Verify only 500 AP total (not 1000)
    async with TestSession() as session:
        wallet_result = await session.execute(
            select(PointWallet).where(
                PointWallet.user_id == user.id,
                PointWallet.point_type == PointType.FAN,
            )
        )
        wallet = wallet_result.scalar_one()
        assert wallet.balance == 100 + GENRE_SUPPORTER_AP_REWARD


# ---------------------------------------------------------------------------
# WP14: Quest API Endpoint Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_quest_api_daily_quests(client, db_session: AsyncSession):
    """GET /api/v1/quests/daily returns quest list."""
    token = await get_auth_token(client, email="daily_api@test.com")

    resp = await client.get(
        "/api/v1/quests/daily",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "quests" in data
    assert "total" in data


@pytest.mark.asyncio
async def test_quest_api_weekly_quests(client, db_session: AsyncSession):
    """GET /api/v1/quests/weekly returns quest list."""
    token = await get_auth_token(client, email="weekly_api@test.com")

    resp = await client.get(
        "/api/v1/quests/weekly",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "quests" in data
    assert "total" in data


@pytest.mark.asyncio
async def test_quest_api_checkin(client, db_session: AsyncSession):
    """POST /api/v1/quests/check-in records daily attendance."""
    token = await get_auth_token(client, email="checkin_api@test.com")

    resp = await client.post(
        "/api/v1/quests/check-in",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "checked_date" in data
    assert "daily_ap" in data
    assert data["daily_ap"] == DAILY_CHECKIN_AP


@pytest.mark.asyncio
async def test_quest_api_checkin_dedup(client, db_session: AsyncSession):
    """POST /api/v1/quests/check-in rejects duplicate check-in."""
    token = await get_auth_token(client, email="checkindup_api@test.com")

    # First check-in
    resp1 = await client.post(
        "/api/v1/quests/check-in",
        headers=auth_headers(token),
    )
    assert resp1.status_code == 200

    # Second check-in same day should fail
    resp2 = await client.post(
        "/api/v1/quests/check-in",
        headers=auth_headers(token),
    )
    # Should get an error (either 400 or 422 or 500 depending on error handler)
    assert resp2.status_code != 200


@pytest.mark.asyncio
async def test_quest_api_badges(client, db_session: AsyncSession):
    """GET /api/v1/quests/badges/my returns badge list."""
    token = await get_auth_token(client, email="badge_api@test.com")

    resp = await client.get(
        "/api/v1/quests/badges/my",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "badges" in data
    assert "total" in data


@pytest.mark.asyncio
async def test_quest_api_streak(client, db_session: AsyncSession):
    """GET /api/v1/quests/attendance/streak returns streak info."""
    token = await get_auth_token(client, email="streak_api@test.com")

    resp = await client.get(
        "/api/v1/quests/attendance/streak",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "current_week_days" in data
    assert "consecutive_weeks" in data
    assert "rescue_remaining" in data


@pytest.mark.asyncio
async def test_quest_api_no_auth(client):
    """Quest endpoints require authentication."""
    endpoints = [
        ("GET", "/api/v1/quests/daily"),
        ("GET", "/api/v1/quests/weekly"),
        ("POST", "/api/v1/quests/check-in"),
        ("GET", "/api/v1/quests/badges/my"),
        ("GET", "/api/v1/quests/attendance/streak"),
    ]
    for method, url in endpoints:
        if method == "GET":
            resp = await client.get(url)
        else:
            resp = await client.post(url)
        assert resp.status_code in (401, 403), f"{method} {url} should require auth"
