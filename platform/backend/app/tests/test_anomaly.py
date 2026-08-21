from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.models.anomaly import AnomalyLogModel
from app.models.event import Event, EventStatus
from app.models.user import User
from app.services.anomaly import AnomalyResult, detect_bid_anomaly
from app.services.anomaly_tracker import AnomalyTracker


def test_normal_bid_not_anomalous():
    result = detect_bid_anomaly(
        bid_amount=80000,
        quantity=1,
        user_bid_count_24h=1,
        all_bids_amounts=[70000, 80000, 90000, 85000, 75000],
        user_account_age_days=30,
    )
    assert result.is_anomalous is False
    assert result.score < 0.5


def test_zscore_anomaly():
    result = detect_bid_anomaly(
        bid_amount=1000,
        quantity=1,
        user_bid_count_24h=1,
        all_bids_amounts=[10, 11, 9, 10, 12],
        user_account_age_days=30,
    )
    assert result.score >= 0.4
    assert any("Z-score" in r for r in result.reasons)


def test_rapid_bidding():
    result = detect_bid_anomaly(
        bid_amount=80,
        quantity=1,
        user_bid_count_24h=11,
        all_bids_amounts=[70, 80, 90, 85, 75],
        user_account_age_days=30,
    )
    assert result.score >= 0.3
    assert any("High bid frequency" in r for r in result.reasons)


def test_new_account_max_qty():
    result = detect_bid_anomaly(
        bid_amount=80,
        quantity=4,
        user_bid_count_24h=1,
        all_bids_amounts=[70, 80, 90, 85, 75],
        user_account_age_days=0,
    )
    assert result.score >= 0.3
    assert any("New account with max quantity" in r for r in result.reasons)


def test_premium_max_qty():
    result = detect_bid_anomaly(
        bid_amount=200,
        quantity=4,
        user_bid_count_24h=1,
        all_bids_amounts=[70, 80, 90, 85, 75],
        user_account_age_days=30,
    )
    assert result.score >= 0.2
    assert any("premium price" in r for r in result.reasons)


def test_same_ip_multiple_users():
    result = detect_bid_anomaly(
        bid_amount=80,
        quantity=1,
        user_bid_count_24h=1,
        all_bids_amounts=[70, 80, 90, 85, 75],
        user_account_age_days=30,
        same_ip_user_count=3,
    )
    assert result.score >= 0.3
    assert any("Same IP" in r for r in result.reasons)


def test_same_device_multiple_users():
    result = detect_bid_anomaly(
        bid_amount=80,
        quantity=1,
        user_bid_count_24h=1,
        all_bids_amounts=[70, 80, 90, 85, 75],
        user_account_age_days=30,
        same_device_user_count=2,
    )
    assert result.score >= 0.35
    assert any("Same device" in r for r in result.reasons)


def test_previous_anomaly_history():
    result = detect_bid_anomaly(
        bid_amount=80,
        quantity=1,
        user_bid_count_24h=1,
        all_bids_amounts=[70, 80, 90, 85, 75],
        user_account_age_days=30,
        user_previous_anomaly_score=0.4,
    )
    assert result.score >= 0.2
    assert any("Previous anomaly history" in r for r in result.reasons)


def test_combined_rules_blocked():
    result = detect_bid_anomaly(
        bid_amount=200,
        quantity=4,
        user_bid_count_24h=12,
        all_bids_amounts=[70, 80, 90, 85, 75],
        user_account_age_days=0,
        same_ip_user_count=3,
    )
    assert result.is_anomalous is True
    assert result.score >= 0.5


@pytest.mark.asyncio
async def test_anomaly_tracker_log(db_session):
    now = datetime.now(timezone.utc)
    organizer = User(
        email="anomaly_org@test.com",
        hashed_password="x",
        name="Org",
        is_organizer=True,
    )
    db_session.add(organizer)
    await db_session.flush()

    event = Event(
        organizer_id=organizer.id,
        title="Anomaly Event",
        slug="test-anomaly-detection",
        venue="Arena",
        event_date=now + timedelta(days=30),
        bidding_opens_at=now - timedelta(days=1),
        bidding_closes_at=now + timedelta(days=1),
        total_seats=100,
        min_price=10.0,
        max_price=100.0,
        status=EventStatus.BIDDING_OPEN,
    )
    db_session.add(event)
    await db_session.flush()

    tracker = AnomalyTracker(db_session)
    anomaly_result = AnomalyResult(
        is_anomalous=True,
        score=0.75,
        reasons=["Rule A", "Rule B"],
    )
    log = await tracker.log_anomaly_check(
        user_id=organizer.id,
        event_id=event.id,
        result=anomaly_result,
        ip_address="127.0.0.1",
        user_agent="pytest-agent",
        fingerprint_hash="fp_hash",
    )
    await db_session.commit()

    row = (
        await db_session.execute(select(AnomalyLogModel).where(AnomalyLogModel.id == log.id))
    ).scalar_one_or_none()
    assert row is not None
    assert row.score == pytest.approx(0.75)
    assert row.is_blocked is True
    assert row.reasons == ["Rule A", "Rule B"]
