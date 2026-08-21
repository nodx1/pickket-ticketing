import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import *  # noqa: F401,F403
from app.tasks.lottery_draw import auto_draw_lotteries
from app.tasks.phase_transition import check_phase_transitions
from app.tasks.queue_processor import process_queues
from app.tasks.resale_matching import auto_match_resale_orders


@compiles(PG_UUID, "sqlite")
def _compile_pg_uuid_sqlite(type_, compiler, **kw):
    return "CHAR(32)"


sync_test_engine = create_engine("sqlite://", echo=False)
SyncTestSession = sessionmaker(sync_test_engine)


@pytest.fixture(autouse=True)
def _reset_db(monkeypatch):
    monkeypatch.setattr("app.tasks.lottery_draw.SyncSession", SyncTestSession)
    monkeypatch.setattr("app.tasks.phase_transition.SyncSession", SyncTestSession)
    monkeypatch.setattr("app.tasks.resale_matching.SyncSession", SyncTestSession)
    Base.metadata.drop_all(sync_test_engine)
    Base.metadata.create_all(sync_test_engine)
    yield
    Base.metadata.drop_all(sync_test_engine)


def test_lottery_draw_smoke():
    result = auto_draw_lotteries.run()
    assert isinstance(result, dict)
    assert "pools_drawn" in result



def test_phase_transition_smoke():
    result = check_phase_transitions.run()
    assert isinstance(result, dict)
    assert "transitions" in result


def test_resale_matching_smoke():
    result = auto_match_resale_orders.run()
    assert isinstance(result, dict)
    assert "matched_trades" in result


def test_queue_processor_smoke(monkeypatch):
    async def _noop():
        return None

    monkeypatch.setattr("app.tasks.queue_processor._process_queues_async", _noop)
    process_queues.run()
