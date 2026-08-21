"""T1-1 (F9) 회귀: convert-to-fcfs 가 존재하지 않는 EventStatus.OPEN 대신
BIDDING_OPEN 으로 전이하는지 검증.

과거 `events.py:1512` / `payment_expiry.py:667` 이 `EventStatus.OPEN` 을 참조해
런타임 AttributeError 로 크래시(API) 하거나 조용히 실패(Celery, stuck 양산)했다.
이 테스트는 (a) enum 드리프트 가드 + (b) API 경로 실전이 를 고정한다.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.main import app
from app.middleware.auth import get_current_admin
from app.models.event import Event, EventStatus, SeatTier
from app.models.user import User


def test_event_status_enum_has_bidding_open_not_open():
    """F9 근본: enum 에 OPEN 은 없고 BIDDING_OPEN 이 정본 목표상태여야 한다."""
    assert not hasattr(EventStatus, "OPEN")
    assert EventStatus.BIDDING_OPEN.value == "bidding_open"
    # 매핑 헬퍼가 참조하는 이름들이 실재하는지 (import-time AttributeError 예방)
    for member in ("BIDDING_OPEN", "BIDDING_CLOSED", "ALLOCATED"):
        assert hasattr(EventStatus, member)


async def _seed_event_with_lottery_tier(db_session) -> uuid.UUID:
    organizer = User(
        email=f"org-{uuid.uuid4().hex[:8]}@fcfs.test",
        hashed_password="!x!",
        name="주최자",
        is_organizer=True,
    )
    db_session.add(organizer)
    await db_session.flush()

    now = datetime.now(timezone.utc)
    event = Event(
        organizer_id=organizer.id,
        title="선착순 전환 테스트",
        slug=f"fcfs-{uuid.uuid4().hex[:8]}",
        venue="테스트홀",
        event_date=now + timedelta(days=30),
        bidding_opens_at=now - timedelta(days=2),
        # 추첨 마감(이미 과거) — 전환 후 event_date 로 연장되어야 함
        bidding_closes_at=now - timedelta(hours=1),
        total_seats=100,
        status=EventStatus.BIDDING_CLOSED,
    )
    db_session.add(event)
    await db_session.flush()

    tier = SeatTier(
        event_id=event.id,
        name="R석",
        capacity=100,
        base_price=50000,
        sale_mode="point_lottery",
        sold_count=10,
    )
    db_session.add(tier)
    await db_session.commit()
    return event.id


@pytest.mark.asyncio
async def test_convert_to_fcfs_sets_bidding_open(client, db_session):
    event_id = await _seed_event_with_lottery_tier(db_session)

    admin = User(
        email=f"admin-{uuid.uuid4().hex[:8]}@fcfs.test",
        hashed_password="!x!",
        name="관리자",
        is_admin=True,
    )
    db_session.add(admin)
    await db_session.commit()

    app.dependency_overrides[get_current_admin] = lambda: admin
    try:
        resp = await client.post(f"/api/v1/events/{event_id}/convert-to-fcfs")
    finally:
        app.dependency_overrides.pop(get_current_admin, None)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["status"] == EventStatus.BIDDING_OPEN.value
    assert body["sale_mode"] == "fixed_fcfs"

    # 영속화 검증: status=BIDDING_OPEN, tier fcfs 전환, 마감 시각 event_date 로 연장
    result = await db_session.execute(select(Event).where(Event.id == event_id))
    ev = result.scalar_one()
    await db_session.refresh(ev)
    assert ev.status == EventStatus.BIDDING_OPEN
    assert ev.bidding_closes_at >= ev.event_date

    tiers = await db_session.execute(select(SeatTier).where(SeatTier.event_id == event_id))
    for t in tiers.scalars().all():
        assert t.sale_mode == "fixed_fcfs"
