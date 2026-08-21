from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import *  # noqa: F401,F403
from app.models.allocation import Allocation, AllocationResult, AllocationStatus
from app.models.bid import Bid, BidStatus
from app.models.event import Event, EventStatus
from app.models.user import User
from app.tasks.allocation import check_batch_windows, run_allocation_async


@compiles(PG_UUID, "sqlite")
def _compile_pg_uuid_sqlite(type_, compiler, **kw):
    return "CHAR(32)"


sync_test_engine = create_engine("sqlite://", echo=False)
SyncTestSession = sessionmaker(sync_test_engine)


@pytest.fixture(autouse=True)
def _reset_db(monkeypatch):
    monkeypatch.setattr("app.tasks.allocation.SyncSession", SyncTestSession)
    Base.metadata.drop_all(sync_test_engine)
    Base.metadata.create_all(sync_test_engine)
    yield
    Base.metadata.drop_all(sync_test_engine)


def _create_event(*, status: EventStatus, closes_at: datetime | None = None) -> Event:
    now = datetime.now(timezone.utc)
    with SyncTestSession() as session:
        organizer = User(
            email=f"alloc_org_{status.value}_{now.timestamp()}@test.com",
            hashed_password="x",
            name="Org",
            is_organizer=True,
        )
        session.add(organizer)
        session.flush()

        event = Event(
            organizer_id=organizer.id,
            title="Allocation Event",
            slug="test-allocation-task",
            venue="Arena",
            event_date=now + timedelta(days=14),
            bidding_opens_at=now - timedelta(days=2),
            bidding_closes_at=closes_at or (now - timedelta(hours=1)),
            total_seats=10,
            min_price=10.0,
            max_price=200.0,
            status=status,
        )
        session.add(event)
        session.commit()
        session.refresh(event)
        return event


def _create_bid(*, event_id, verification_level: int = 2, amount: float = 80.0):
    with SyncTestSession() as session:
        bidder = User(
            email=f"alloc_bidder_{datetime.now(timezone.utc).timestamp()}@test.com",
            hashed_password="x",
            name="Bidder",
            verification_level=verification_level,
        )
        session.add(bidder)
        session.flush()
        bid = Bid(
            user_id=bidder.id,
            event_id=event_id,
            max_willingness_to_pay=amount,
            quantity=1,
            status=BidStatus.ACTIVE,
        )
        session.add(bid)
        session.commit()
        return bid


def test_check_batch_windows_closes():
    event = _create_event(status=EventStatus.BIDDING_OPEN)

    result = check_batch_windows.run()
    assert result["closed"] == 1

    with SyncTestSession() as session:
        refreshed = session.execute(select(Event).where(Event.id == event.id)).scalar_one()
        assert refreshed.status == EventStatus.BIDDING_CLOSED


def test_check_batch_windows_future():
    future_close = datetime.now(timezone.utc) + timedelta(hours=6)
    event = _create_event(status=EventStatus.BIDDING_OPEN, closes_at=future_close)

    result = check_batch_windows.run()
    assert result["closed"] == 0

    with SyncTestSession() as session:
        refreshed = session.execute(select(Event).where(Event.id == event.id)).scalar_one()
        assert refreshed.status == EventStatus.BIDDING_OPEN


def test_run_allocation_normal():
    event = _create_event(status=EventStatus.BIDDING_OPEN)
    _create_bid(event_id=event.id, verification_level=2, amount=90.0)
    _create_bid(event_id=event.id, verification_level=2, amount=95.0)

    result = run_allocation_async.run(str(event.id))
    assert "winners" in result
    assert result["winners"] >= 1

    with SyncTestSession() as session:
        allocation = session.execute(
            select(Allocation).where(Allocation.event_id == event.id)
        ).scalar_one_or_none()
        assert allocation is not None
        assert allocation.status == AllocationStatus.COMPLETED

        winner_rows = (
            session.execute(
                select(AllocationResult).where(AllocationResult.allocation_id == allocation.id)
            )
            .scalars()
            .all()
        )
        assert len(winner_rows) >= 1


def test_run_allocation_idempotent():
    event = _create_event(status=EventStatus.BIDDING_OPEN)

    with SyncTestSession() as session:
        existing = Allocation(
            event_id=event.id,
            status=AllocationStatus.COMPLETED,
            total_bids=1,
            total_allocated=1,
        )
        session.add(existing)
        session.commit()

    result = run_allocation_async.run(str(event.id))
    assert result.get("idempotent_skip") is True
    assert "already exists" in result.get("error", "")


def test_run_allocation_no_bids():
    event = _create_event(status=EventStatus.BIDDING_OPEN)

    result = run_allocation_async.run(str(event.id))
    assert result["error"] == "No active bids"
