"""
Test configuration for Pickket backend.

Uses SQLite (aiosqlite) as an in-memory test database with StaticPool
so that all connections share the same in-memory database.

Requires: pip install aiosqlite
"""

import asyncio
import uuid
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock

import pytest
import pytest_asyncio

try:
    import uvloop
except ModuleNotFoundError:  # pragma: no cover - optional dependency
    uvloop = None
from httpx import AsyncClient, ASGITransport
from sqlalchemy import event as sa_event, select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.core.database import Base, get_db, get_read_db
from app.models import (  # noqa: F401 — ensure all models registered
    User,
    Event,
    SeatTier,
    Bid,
    Allocation,
    AllocationResult,
    UserInteraction,
    Seat,
    Ticket,
    Order,
    OwnershipTransfer,
    PhaseConfig,
    LotteryPool,
    LotteryEntry,
    WaitlistEntryModel,
    NotificationModel,
    PriceAlertModel,
    AuditEntryModel,
    AuditLog,
    SessionHistoryModel,
    GroupModel,
    GroupMemberModel,
    ResaleListingModel,
    ResaleBuyOrderModel,
    EventStaffAssignment,
    TemplateChangeRequest,
    TemplateChangeStatus,
    OrganizerTeamMember,
    TeamRole,
    PityTracker,
    ShopItem,
    ShopExchange,
    ShopCategory,
    ShopExchangeStatus,
    # Phase B3+B4 models
    EventPage,
    ArtistMessage,
    AnticipationSession,
    DigitalPhotocard,
    FanLetter,
    CustomDomain,
    DomainStatus,
    ABTest,
    PasswordHistory,
)
from app.main import app
from app.middleware.rate_limit import (
    auth_limiter,
    bid_limiter,
    checkin_limiter,
    general_limiter,
    payment_limiter,
    webhook_limiter,
)

# ---------------------------------------------------------------------------
# SQLite compatibility: PostgreSQL UUID columns become CHAR(32) on SQLite
# ---------------------------------------------------------------------------
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.compiler import compiles


@compiles(PG_UUID, "sqlite")
def _compile_pg_uuid_sqlite(type_, compiler, **kw):
    """Render PostgreSQL UUID type as CHAR(32) when targeting SQLite."""
    return "CHAR(32)"


# ---------------------------------------------------------------------------
# Test engine / session factory
#
# StaticPool ensures every connection returns the same underlying SQLite
# database, which is necessary for in-memory SQLite because the default
# QueuePool opens separate connections that each get their own empty database.
# ---------------------------------------------------------------------------

TEST_DATABASE_URL = "sqlite+aiosqlite://"

test_engine = create_async_engine(
    TEST_DATABASE_URL,
    echo=False,
    poolclass=StaticPool,
    connect_args={"check_same_thread": False},
)
TestSession = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)


# SQLite doesn't enforce foreign keys by default -- enable them.
@sa_event.listens_for(test_engine.sync_engine, "connect")
def _set_sqlite_pragma(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()

    # Register PostgreSQL-compatible functions for SQLite test compatibility
    def _date_trunc(part, value):
        """Minimal date_trunc for SQLite: supports 'day' truncation."""
        if value is None:
            return None
        from datetime import datetime as _dt
        if isinstance(value, str):
            dt = _dt.fromisoformat(value.replace("Z", "+00:00"))
        else:
            dt = value
        if part == "day":
            return dt.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        return value

    dbapi_conn.create_function("date_trunc", 2, _date_trunc)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_rate_limiters():
    """Raise rate limits for test environment so tests aren't throttled."""
    general_limiter.max_requests = 10000
    auth_limiter.max_requests = 10000
    bid_limiter.max_requests = 10000
    payment_limiter.max_requests = 10000
    checkin_limiter.max_requests = 10000
    webhook_limiter.max_requests = 10000


@pytest.fixture(autouse=True)
def _reset_error_rate_window():
    """Clear the error-rate alert window between tests.

    `app.middleware.metrics` keeps a module-global request/error deque that is
    NOT request- or test-scoped. Tests that deliberately exercise 4xx/5xx paths
    would otherwise accumulate across files and trip the error-rate alert mid-
    suite, firing a stray background Telegram task — a source of cross-test,
    order-dependent flakiness. Reset it before each test.
    """
    import app.middleware.metrics as _metrics

    _metrics._request_counts.clear()
    _metrics._last_alert_time = 0.0
    yield


@pytest.fixture(autouse=True)
def _enable_kill_switched_features():
    """Enable kill-switched features in test environment so tests can exercise them."""
    original_resale = settings.RESALE_ENABLED
    settings.RESALE_ENABLED = True
    yield
    settings.RESALE_ENABLED = original_resale


@pytest.fixture
def allow_partial_cancel():
    """부분취소 가드를 이 테스트에서만 연다.

    🔴 기본은 **차단**이다(`NICEPAY_ALLOW_PARTIAL_CANCEL=False`) — 나이스 구형이
    부분취소에 새 TID 를 주는데 게이트웨이가 원 TID 를 강제해, 실서버에서 **돈만 나가고
    원장이 안 바뀐다**. 상세는 `nicepay_gateway.PartialCancelUnsupportedError`.

    아래 원장·재고·티켓 회계를 검증하는 부분환불 테스트들은 그 회계 자체가 대상이지
    PG 전문이 대상이 아니므로, 명시적으로 플래그를 열고 돈다. **가드 자체의 검증은
    `test_partial_cancel_guard.py`** 가 담당한다(그쪽은 절대 이 픽스처를 쓰지 않는다).

    ⚠️ 이 픽스처를 새 테스트에 무심코 붙이지 말 것 — 가드를 무력화한다.
    """
    original = settings.NICEPAY_ALLOW_PARTIAL_CANCEL
    settings.NICEPAY_ALLOW_PARTIAL_CANCEL = True
    yield
    settings.NICEPAY_ALLOW_PARTIAL_CANCEL = original


@pytest.fixture(scope="session")
def event_loop_policy():
    """Use uvloop so thread-safe callbacks (aiosqlite) work reliably in tests."""
    if uvloop is None:
        return asyncio.DefaultEventLoopPolicy()
    return uvloop.EventLoopPolicy()


@pytest.fixture(autouse=True)
def _mock_redis(monkeypatch):
    """Mock Redis for tests that don't need real Redis.

    Provides a FakeRedis that supports pipeline operations (ZSET commands)
    used by the Redis-based rate limiter, as well as basic get/set/ping.
    """
    import app.core.redis as redis_module

    class FakePipeline:
        """Collects pipeline commands and returns pre-set results on execute."""

        def __init__(self, transaction=False):
            self._commands = []

        def zremrangebyscore(self, key, min_score, max_score):
            self._commands.append(("zremrangebyscore", key, min_score, max_score))
            return self

        def zcard(self, key):
            self._commands.append(("zcard", key))
            return self

        def zadd(self, key, mapping):
            self._commands.append(("zadd", key, mapping))
            return self

        def expire(self, key, seconds):
            self._commands.append(("expire", key, seconds))
            return self

        async def execute(self):
            # Return results matching command order:
            # zremrangebyscore -> 0 removed, zcard -> 0 (allows all), zadd -> 1, expire -> True
            results = []
            for cmd in self._commands:
                if cmd[0] == "zremrangebyscore":
                    results.append(0)
                elif cmd[0] == "zcard":
                    results.append(0)  # always report 0 entries -> never rate-limited
                elif cmd[0] == "zadd":
                    results.append(1)
                elif cmd[0] == "expire":
                    results.append(True)
                else:
                    results.append(None)
            return results

    class FakeRedis:
        def __init__(self):
            self._kv: dict[str, str] = {}

        async def set(self, *args, **kwargs):
            key = str(args[0]) if args else str(kwargs.get("name"))
            value = str(args[1]) if len(args) > 1 else str(kwargs.get("value"))
            nx = bool(kwargs.get("nx"))
            if nx and key in self._kv:
                return False
            self._kv[key] = value
            return True

        async def get(self, *args, **kwargs):
            key = str(args[0]) if args else str(kwargs.get("name"))
            return self._kv.get(key)

        async def delete(self, *args, **kwargs):
            deleted = 0
            for raw_key in args:
                key = str(raw_key)
                if key in self._kv:
                    del self._kv[key]
                    deleted += 1
            return deleted

        async def setex(self, *args, **kwargs):
            if args:
                key = str(args[0])
                value = str(args[2]) if len(args) > 2 else ""
            else:
                key = str(kwargs.get("name"))
                value = str(kwargs.get("value", ""))
            self._kv[key] = value
            return True

        async def incr(self, key):
            k = str(key)
            current = int(self._kv.get(k, "0"))
            current += 1
            self._kv[k] = str(current)
            return current

        async def ttl(self, key):
            # FakeRedis doesn't track TTL; return -2 (key doesn't exist) or -1 (no TTL).
            k = str(key)
            return -1 if k in self._kv else -2

        async def expire(self, key, seconds):
            # TTL is not enforced in tests; return success for compatibility.
            _ = seconds
            return str(key) in self._kv

        async def eval(self, *args, **kwargs):
            script = str(args[0]) if args else ""

            # Account lockout: atomic INCR + EXPIRE
            if "INCR" in script and "EXPIRE" in script and "redis.call" in script:
                key = str(args[2])
                current = int(self._kv.get(key, "0"))
                current += 1
                self._kv[key] = str(current)
                return current

            if "refresh_rotation_atomic" in script:
                family_key = str(args[2])
                used_jti_key = str(args[3])
                provided_hash = str(args[4])
                new_refresh_hash = str(args[6])

                stored_hash = self._kv.get(family_key)
                if stored_hash is None:
                    return "reuse" if used_jti_key in self._kv else "revoked"

                if used_jti_key in self._kv:
                    self._kv.pop(family_key, None)
                    return "reuse"

                if stored_hash != provided_hash:
                    self._kv.pop(family_key, None)
                    return "mismatch"

                self._kv[used_jti_key] = "1"
                self._kv[family_key] = new_refresh_hash
                return "ok"

            if "redis.call('get',KEYS[1])==ARGV[1]" in script:
                key = str(args[2])
                expected_value = str(args[3])
                current_value = self._kv.get(key)
                if current_value != expected_value:
                    return 0

                if "redis.call('del',KEYS[1])" in script:
                    self._kv.pop(key, None)
                    return 1

                if "redis.call('expire',KEYS[1],ARGV[2])" in script:
                    # TTL is not enforced in the fake Redis, but the lock
                    # renewal path needs a successful compare-and-renew result.
                    return 1

            if "ZREMRANGEBYSCORE" in script and "max_requests" in script:
                return [1, 9999]

            return 1

        async def publish(self, *args, **kwargs):
            return 0

        async def ping(self):
            return True

        async def zcard(self, *args, **kwargs):
            return 0

        async def zadd(self, *args, **kwargs):
            return 1

        async def zrange(self, *args, **kwargs):
            return []

        async def zrank(self, *args, **kwargs):
            return None

        async def zscore(self, *args, **kwargs):
            return None

        async def zrem(self, *args, **kwargs):
            return 1

        async def zpopmin(self, *args, **kwargs):
            return []

        async def scan_iter(self, *args, **kwargs):
            if False:  # pragma: no cover - keep async generator interface
                yield ""
            return

        def pipeline(self, transaction=False):
            return FakePipeline(transaction=transaction)

        async def exists(self, *args, **kwargs):
            count = 0
            for key in args:
                if str(key) in self._kv:
                    count += 1
            return count

        async def scan(self, cursor=0, match=None, count=100):
            keys = list(self._kv.keys())
            if match:
                import fnmatch

                keys = [k for k in keys if fnmatch.fnmatch(k, match)]
            return (0, keys)

        async def close(self):
            pass

    fake = FakeRedis()
    monkeypatch.setattr(redis_module, "redis_pool", fake)

    # inventory_service keeps a module-level SYNC redis singleton (_sync_redis_client)
    # that _mock_redis does NOT cover. Without this, a test that triggers
    # release_sync() would open a REAL redis connection, cache it in the module
    # global, and leak it into every subsequent test in the process. Reset the
    # singleton and stub the factory so the sync path is inert in tests.
    try:
        import app.services.inventory_service as _inv_module

        _inv_module._sync_redis_client = None
        monkeypatch.setattr(_inv_module, "_get_sync_redis", lambda: MagicMock())
    except Exception:
        pass


@pytest_asyncio.fixture(scope="function")
async def db_session():
    """Create all tables before each test, drop them afterward."""
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with TestSession() as session:
        yield session

    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture(scope="function")
async def client(db_session: AsyncSession):
    """
    Provide an httpx AsyncClient wired to the FastAPI app, with the DB
    dependency overridden to use the test session factory.

    The db_session fixture dependency ensures tables exist before requests
    are made and are cleaned up afterward.
    """

    async def _override_get_db():
        async with TestSession() as session:
            try:
                yield session
            finally:
                await session.close()

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_read_db] = _override_get_db

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        cookies={},
    ) as ac:
        yield ac

    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------


async def register_user(
    client: AsyncClient,
    email: str = "test@example.com",
    password: str = "Password1!test",
    name: str = "Test User",
    phone: str | None = None,
    is_organizer: bool = False,
) -> dict:
    """Register a user and return the full JSON response body."""
    cookie_snapshot = [
        (cookie.name, cookie.value, cookie.domain, cookie.path)
        for cookie in client.cookies.jar
    ]
    payload = {
        "email": email,
        "password": password,
        "name": name,
    }
    if phone is not None:
        payload["phone"] = phone
    try:
        response = await client.post("/api/v1/auth/register", json=payload)
        body = response.json()

        # is_organizer is no longer accepted via the API (SEC-2).
        # Promote the user directly in the DB when tests need an organizer.
        if is_organizer and "user" in body and "id" in body["user"]:
            from app.models.user import User as _User

            async with TestSession() as session:
                result = await session.execute(
                    select(_User).where(_User.id == uuid.UUID(body["user"]["id"]))
                )
                user = result.scalar_one()
                user.is_organizer = True
                await session.commit()
            body["user"]["is_organizer"] = True

        return body
    finally:
        client.cookies.clear()
        for name, value, domain, path in cookie_snapshot:
            client.cookies.set(name, value, domain=domain, path=path)


async def get_auth_token(
    client: AsyncClient,
    email: str = "test@example.com",
    password: str = "Password1!test",
    name: str = "Test User",
    is_organizer: bool = False,
) -> str:
    """Register a user and return just the access token."""
    data = await register_user(
        client, email=email, password=password, name=name, is_organizer=is_organizer
    )
    return data["access_token"]


def auth_headers(token: str) -> dict:
    """Return an Authorization header dict for the given JWT."""
    return {"Authorization": f"Bearer {token}"}


async def set_verification_level(user_id: str, level: int = 1):
    """Set a user's verification_level directly in the DB (test helper)."""
    async with TestSession() as session:
        result = await session.execute(select(User).where(User.id == uuid.UUID(user_id)))
        user = result.scalar_one()
        user.verification_level = level
        await session.commit()


async def set_fanclub_member(user_id: str, is_member: bool = True):
    """Set a user's is_fanclub_member flag directly in the DB (test helper)."""
    async with TestSession() as session:
        result = await session.execute(select(User).where(User.id == uuid.UUID(user_id)))
        user = result.scalar_one()
        user.is_fanclub_member = is_member
        await session.commit()


# ---------------------------------------------------------------------------
# Event helpers
# ---------------------------------------------------------------------------


def make_event_payload(
    *,
    title: str = "Test Concert",
    description: str | None = "A fun concert",
    venue: str = "Test Arena",
    event_date: str | None = None,
    bidding_opens_at: str | None = None,
    bidding_closes_at: str | None = None,
    total_seats: int = 100,
    min_price: float = 10.0,
    max_price: float | None = 500.0,
    category: str = "CONCERT",
    location_city: str | None = None,
    artist_name: str | None = None,
    image_url: str | None = None,
    is_featured: bool = False,
    event_date_end: str | None = None,
    time_slot_enabled: bool = False,
    time_slot_capacity: int | None = None,
    time_slot_duration_minutes: int | None = None,
) -> dict:
    """Build a valid EventCreate JSON payload.

    By default the bidding window is already open (opened 1 hour ago)
    and closes 24 hours from now.
    """
    now = datetime.now(timezone.utc)
    payload = {
        "title": title,
        "description": description,
        "venue": venue,
        "event_date": event_date or (now + timedelta(days=30)).isoformat(),
        "bidding_opens_at": bidding_opens_at or (now - timedelta(hours=1)).isoformat(),
        "bidding_closes_at": bidding_closes_at or (now + timedelta(hours=24)).isoformat(),
        "total_seats": total_seats,
        "min_price": min_price,
        "max_price": max_price,
        "category": category,
        "is_featured": is_featured,
        "time_slot_enabled": time_slot_enabled,
    }
    if event_date_end is not None:
        payload["event_date_end"] = event_date_end
    if location_city is not None:
        payload["location_city"] = location_city
    if artist_name is not None:
        payload["artist_name"] = artist_name
    if image_url is not None:
        payload["image_url"] = image_url
    if time_slot_capacity is not None:
        payload["time_slot_capacity"] = time_slot_capacity
    if time_slot_duration_minutes is not None:
        payload["time_slot_duration_minutes"] = time_slot_duration_minutes
    return payload


async def create_event_as_organizer(
    client: AsyncClient,
    token: str,
    *,
    status: str = "bidding_open",
    **event_overrides,
) -> dict:
    """Create an event using the given organizer token and return the response JSON.

    By default the event is set to BIDDING_OPEN so purchase tests work.
    Pass status=None to keep the original DRAFT status.
    """
    payload = make_event_payload(**event_overrides)
    response = await client.post(
        "/api/v1/events/",
        json=payload,
        headers=auth_headers(token),
    )
    data = response.json()

    # Auto-set event status for test convenience
    if status and "id" in data:
        from app.models.event import Event

        async with TestSession() as session:
            result = await session.execute(
                select(Event).where(Event.id == uuid.UUID(data["id"]))
            )
            event = result.scalar_one()
            event.status = status
            await session.commit()

    return data


async def confirm_purchase_payment(
    client: AsyncClient,
    token: str,
    order_id: str,
) -> dict:
    """Confirm payment for a PAYMENT_REQUIRED order using stub PG data.

    After the purchase flow change, orders are created with PAYMENT_REQUIRED
    status and tickets with PENDING status. This helper simulates a successful
    payment confirmation so that the order becomes CONFIRMED and tickets ACTIVE.
    """
    resp = await client.post(
        f"/api/v1/orders/{order_id}/pay",
        json={"pg_provider": "portone", "pg_transaction_id": f"stub_txn_{order_id[:8]}"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, f"Payment confirmation failed: {resp.text}"
    return resp.json()
