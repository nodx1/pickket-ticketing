"""auto_capture/auto_void 멱등성 — commit 실패 후 재시도 시 PG 재호출 없이 DB 복구."""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import *  # noqa: F401,F403
from app.models.event import Event
from app.models.order import Order, OrderStatus
from app.tasks.payment_capture import (
    auto_capture_authorized,
    auto_void_stale_authorizations,
)


@compiles(PG_UUID, "sqlite")
def _compile_pg_uuid_sqlite(type_, compiler, **kw):
    return "CHAR(32)"


sync_test_engine = create_engine("sqlite://", echo=False)
SyncTestSession = sessionmaker(sync_test_engine)


# ── Fakes ─────────────────────────────────────────────────────────────


class FakeRedis:
    """In-memory stand-in for the sync Redis client used by idempotency helpers."""

    def __init__(self, store: dict):
        self.store = store

    def exists(self, key):
        return key in self.store

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    def setex(self, key, ttl, value):
        self.store[key] = value

    def get(self, key):
        return self.store.get(key)

    def delete(self, key):
        self.store.pop(key, None)


class FakeCaptureResult:
    def __init__(self, payment_id):
        self.provider = "portone"
        self.payment_id = payment_id
        self.transaction_id = f"txn_{payment_id}"
        self.amount = 10000.0
        self.captured_at = datetime.now(timezone.utc)
        self.raw = {"mode": "fake", "status": "captured"}


class FakeVoidResult:
    def __init__(self, payment_id):
        self.provider = "portone"
        self.payment_id = payment_id
        self.voided = True
        self.raw = {"mode": "fake", "status": "cancelled"}


class FakeGateway:
    capture_calls = 0
    void_calls = 0

    async def capture_payment(self, *, payment_id, amount):
        FakeGateway.capture_calls += 1
        return FakeCaptureResult(payment_id)

    async def void_authorization(self, *, payment_id, reason):
        FakeGateway.void_calls += 1
        return FakeVoidResult(payment_id)


def _failing_commit_factory(fail_times: int):
    """SyncSession factory whose commit() raises `fail_times` times."""
    state = {"remaining": fail_times}

    def factory():
        sess = SyncTestSession()
        real_commit = sess.commit

        def commit():
            if state["remaining"] > 0:
                state["remaining"] -= 1
                raise RuntimeError("simulated commit failure")
            real_commit()

        sess.commit = commit
        return sess

    return factory


# ── Fixtures ──────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    store: dict = {}
    monkeypatch.setattr(
        "app.tasks.payment_capture._get_sync_redis", lambda: FakeRedis(store)
    )
    monkeypatch.setattr(
        "app.tasks.reconciliation._get_sync_redis", lambda: FakeRedis(store)
    )
    monkeypatch.setattr(
        "app.tasks.payment_capture.get_payment_gateway", lambda: FakeGateway()
    )
    monkeypatch.setattr("app.tasks.payment_capture.SyncSession", SyncTestSession)
    FakeGateway.capture_calls = 0
    FakeGateway.void_calls = 0
    Base.metadata.drop_all(sync_test_engine)
    Base.metadata.create_all(sync_test_engine)
    yield store
    Base.metadata.drop_all(sync_test_engine)


def _create_authorized_order(*, event_date: datetime, authorized_at: datetime) -> uuid.UUID:
    session = SyncTestSession()
    try:
        now = datetime.now(timezone.utc)
        event = Event(
            organizer_id=uuid.uuid4(),
            title="Test Event",
            slug=f"test-{uuid.uuid4().hex[:8]}",
            venue="Test Venue",
            event_date=event_date,
            bidding_opens_at=now - timedelta(days=60),
            bidding_closes_at=now - timedelta(days=50),
            total_seats=100,
        )
        session.add(event)
        session.flush()
        order = Order(
            user_id=uuid.uuid4(),
            event_id=event.id,
            status=OrderStatus.AUTHORIZED,
            quantity=1,
            unit_price=10000,
            total_amount=10000,
            payment_id="pay_test_1",
            authorized_at=authorized_at,
        )
        session.add(order)
        session.commit()
        return order.id
    finally:
        session.close()


def _get_order(order_id: uuid.UUID) -> Order:
    session = SyncTestSession()
    try:
        return session.get(Order, order_id)
    finally:
        session.close()


# ── Tests ─────────────────────────────────────────────────────────────


def test_capture_commit_failure_then_retry_recovers_without_pg_recall(_setup, monkeypatch):
    store = _setup
    now = datetime.now(timezone.utc)
    order_id = _create_authorized_order(
        event_date=now - timedelta(days=3), authorized_at=now - timedelta(days=3)
    )
    idem_key = f"v2:reconcile:{order_id}:capture"

    # 1차 실행: PG capture 성공 후 DB commit 실패
    monkeypatch.setattr(
        "app.tasks.payment_capture.SyncSession", _failing_commit_factory(1)
    )
    with pytest.raises(RuntimeError):
        auto_capture_authorized.run()

    assert FakeGateway.capture_calls == 1
    assert _get_order(order_id).status == OrderStatus.AUTHORIZED  # DB는 롤백됨
    assert idem_key not in store  # 완료 멱등 키는 commit 전에는 설정되지 않음
    assert f"{idem_key}:pg_done" in store  # PG 결과는 복구용으로 보존
    assert f"{idem_key}:inprogress" not in store  # 락 해제 → 재시도 차단 없음

    # 2차 실행(재시도): PG 재호출 없이 저장된 결과로 DB만 복구
    monkeypatch.setattr("app.tasks.payment_capture.SyncSession", SyncTestSession)
    result = auto_capture_authorized.run()

    assert result["captured_orders"] == 1
    assert FakeGateway.capture_calls == 1  # PG 재호출 없음
    order = _get_order(order_id)
    assert order.status == OrderStatus.CONFIRMED
    assert order.captured_at is not None
    assert idem_key in store  # commit 성공 후에만 완료 멱등 키 확정
    assert f"{idem_key}:pg_done" not in store
    assert f"{idem_key}:inprogress" not in store


def test_void_commit_failure_then_retry_recovers_without_pg_recall(_setup, monkeypatch):
    store = _setup
    now = datetime.now(timezone.utc)
    order_id = _create_authorized_order(
        event_date=now + timedelta(days=10), authorized_at=now - timedelta(days=31)
    )
    idem_key = f"v2:reconcile:{order_id}:void"

    # 1차 실행: PG void 성공 후 DB commit 실패
    monkeypatch.setattr(
        "app.tasks.payment_capture.SyncSession", _failing_commit_factory(1)
    )
    with pytest.raises(RuntimeError):
        auto_void_stale_authorizations.run()

    assert FakeGateway.void_calls == 1
    assert _get_order(order_id).status == OrderStatus.AUTHORIZED  # DB는 롤백됨
    assert idem_key not in store
    assert f"{idem_key}:pg_done" in store
    assert f"{idem_key}:inprogress" not in store

    # 2차 실행(재시도): PG 재호출 없이 저장된 결과로 DB만 복구
    monkeypatch.setattr("app.tasks.payment_capture.SyncSession", SyncTestSession)
    result = auto_void_stale_authorizations.run()

    assert result["voided_orders"] == 1
    assert FakeGateway.void_calls == 1  # PG 재호출 없음
    order = _get_order(order_id)
    assert order.status == OrderStatus.CANCELLED
    assert order.payment_failed_reason == "authorization_expired_30_days"
    assert idem_key in store
    assert f"{idem_key}:pg_done" not in store


def test_capture_skips_order_when_in_progress_lock_held(_setup):
    store = _setup
    now = datetime.now(timezone.utc)
    order_id = _create_authorized_order(
        event_date=now - timedelta(days=3), authorized_at=now - timedelta(days=3)
    )
    store[f"v2:reconcile:{order_id}:capture:inprogress"] = "1"  # 동시 실행 중

    result = auto_capture_authorized.run()

    assert result["captured_orders"] == 0
    assert FakeGateway.capture_calls == 0  # 락이 PG 호출을 막음
    assert _get_order(order_id).status == OrderStatus.AUTHORIZED


def test_capture_completion_key_blocks_reprocessing(_setup):
    store = _setup
    now = datetime.now(timezone.utc)
    order_id = _create_authorized_order(
        event_date=now - timedelta(days=3), authorized_at=now - timedelta(days=3)
    )
    store[f"v2:reconcile:{order_id}:capture"] = "1"  # 이미 완료 처리됨

    result = auto_capture_authorized.run()

    assert result["captured_orders"] == 0
    assert FakeGateway.capture_calls == 0
