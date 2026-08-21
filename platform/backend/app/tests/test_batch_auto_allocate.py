import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import *  # noqa: F401,F403
from app.models.event import Event, EventStatus
from app.models.user import User
from app.tasks.allocation import check_batch_windows


@compiles(PG_UUID, "sqlite")
def _compile_pg_uuid_sqlite(type_, compiler, **kw):
    return "CHAR(32)"


sync_engine = create_engine("sqlite://", echo=False)
TestSyncSession = sessionmaker(sync_engine)


@pytest.fixture(autouse=True)
def _reset_db(monkeypatch):
    monkeypatch.setattr("app.tasks.allocation.SyncSession", TestSyncSession)
    Base.metadata.drop_all(sync_engine)
    Base.metadata.create_all(sync_engine)
    yield
    Base.metadata.drop_all(sync_engine)


def _create_event(*, status: EventStatus, closes_delta_hours: int):
    now = datetime.now(timezone.utc)
    with TestSyncSession() as session:
        organizer = User(
            email=f"batch_org_{status.value}_{closes_delta_hours}@test.com",
            hashed_password="x",
            name="Org",
            is_organizer=True,
        )
        session.add(organizer)
        session.flush()

        event = Event(
            organizer_id=organizer.id,
            title="Batch Event",
            slug=f"test-batch-{uuid.uuid4().hex[:8]}",
            venue="Arena",
            event_date=now + timedelta(days=20),
            bidding_opens_at=now - timedelta(days=2),
            bidding_closes_at=now + timedelta(hours=closes_delta_hours),
            total_seats=100,
            min_price=10.0,
            max_price=100.0,
            status=status,
        )
        session.add(event)
        session.commit()
        return event.id


def test_batch_close_triggers_allocation():
    event_id = _create_event(status=EventStatus.BIDDING_OPEN, closes_delta_hours=-1)

    with patch("app.tasks.allocation.run_allocation_async.delay") as delay_mock:
        result = check_batch_windows.run()

    assert result["closed"] == 1
    assert result["allocation_triggered"] == 1
    delay_mock.assert_called_once_with(str(event_id))

    with TestSyncSession() as session:
        event = session.execute(select(Event).where(Event.id == event_id)).scalar_one()
        assert event.status == EventStatus.BIDDING_CLOSED


def test_batch_close_no_trigger_for_future_window():
    _create_event(status=EventStatus.BIDDING_OPEN, closes_delta_hours=4)

    with patch("app.tasks.allocation.run_allocation_async.delay") as delay_mock:
        result = check_batch_windows.run()

    assert result["closed"] == 0
    assert result["allocation_triggered"] == 0
    delay_mock.assert_not_called()


def test_batch_close_already_closed_skipped():
    event_id = _create_event(status=EventStatus.BIDDING_CLOSED, closes_delta_hours=-1)

    with patch("app.tasks.allocation.run_allocation_async.delay") as delay_mock:
        result = check_batch_windows.run()

    assert result["closed"] == 0
    assert result["allocation_triggered"] == 0
    delay_mock.assert_not_called()

    with TestSyncSession() as session:
        event = session.execute(select(Event).where(Event.id == event_id)).scalar_one()
        assert event.status == EventStatus.BIDDING_CLOSED


def test_batch_close_multiple_events():
    event_ids = [
        _create_event(status=EventStatus.BIDDING_OPEN, closes_delta_hours=-2),
        _create_event(status=EventStatus.BIDDING_OPEN, closes_delta_hours=-3),
        _create_event(status=EventStatus.BIDDING_OPEN, closes_delta_hours=-4),
    ]

    with patch("app.tasks.allocation.run_allocation_async.delay") as delay_mock:
        result = check_batch_windows.run()

    assert result["closed"] == 3
    assert result["allocation_triggered"] == 3
    assert delay_mock.call_count == 3
    called_ids = {call.args[0] for call in delay_mock.call_args_list}
    assert called_ids == {str(eid) for eid in event_ids}


def test_allocation_trigger_failure_logged():
    _create_event(status=EventStatus.BIDDING_OPEN, closes_delta_hours=-1)

    warning_mock = MagicMock()
    with patch("app.tasks.allocation.run_allocation_async.delay", side_effect=Exception("boom")):
        with patch("app.tasks.allocation.logger.warning", warning_mock):
            result = check_batch_windows.run()

    assert result["closed"] == 1
    assert result["allocation_triggered"] == 0
    warning_mock.assert_called()
