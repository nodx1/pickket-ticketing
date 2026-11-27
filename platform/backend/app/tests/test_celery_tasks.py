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


def test_draw_pool_opens_redis_in_worker(monkeypatch):
    """🔴 Celery 워커에는 API 서버의 시작 훅(init_redis)이 없다.

    추첨의 분산 락이 「Redis not initialized」로 실패해 마감 뒤 자동 추첨이 한 건도 안 됐다
    (2026-11-27 로컬 실측: 밀린 추첨 6건 모두 실패). 자동 추첨은 추첨 전에 Redis 를 열고 끝나면 닫아야 한다.
    """
    import app.core.redis as rc
    from app.services.lottery_service import LotteryService
    from app.tasks.async_runner import run_async
    from app.tasks.lottery_draw import _draw_pool

    events: list[str] = []

    async def fake_init():
        events.append("init")
        rc.redis_pool = object()

    async def fake_close():
        events.append("close")
        rc.redis_pool = None

    async def fake_commit(self, pool_id):
        events.append("commit")

    async def fake_draw(self, pool_id):
        rc.get_redis()  # 워커에서는 바로 여기서 RuntimeError("Redis not initialized") 가 났다
        events.append("draw")
        return {"ok": True}

    monkeypatch.setattr(rc, "redis_pool", None)
    monkeypatch.setattr(rc, "init_redis", fake_init)
    monkeypatch.setattr(rc, "close_redis", fake_close)
    monkeypatch.setattr(LotteryService, "ensure_commitment", fake_commit)
    monkeypatch.setattr(LotteryService, "draw", fake_draw)

    assert run_async(_draw_pool("pool-1")) == {"ok": True}
    assert events == ["init", "commit", "draw", "close"]
    assert rc.redis_pool is None
