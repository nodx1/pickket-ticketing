import ssl
from contextlib import asynccontextmanager

from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.core.config import settings


def _is_postgresql_url(url: str) -> bool:
    return url.startswith("postgresql")


def _build_engine_kwargs(url: str, *, read_only: bool = False) -> dict:
    kwargs: dict = {
        "echo": False,
        "pool_pre_ping": True,
        "pool_recycle": settings.DB_POOL_RECYCLE_SECONDS,
    }

    if not _is_postgresql_url(url):
        return kwargs

    connect_args: dict = {
        "timeout": settings.DB_CONNECT_TIMEOUT_SECONDS,
        "server_settings": {
            "application_name": (
                f"{settings.DB_APPLICATION_NAME}-read"
                if read_only
                else settings.DB_APPLICATION_NAME
            ),
            "statement_timeout": str(settings.DB_STATEMENT_TIMEOUT_MS),
            "lock_timeout": str(settings.DB_LOCK_TIMEOUT_MS),
            "idle_in_transaction_session_timeout": str(settings.DB_IDLE_IN_TXN_TIMEOUT_MS),
        },
    }

    # PgBouncer transaction-mode: disable prepared statement cache
    if settings.DB_PGBOUNCER_MODE:
        connect_args["prepared_statement_cache_size"] = 0

    if settings.DB_REQUIRE_SSL:
        ssl_context = ssl.create_default_context(
            cafile=settings.DB_SSL_ROOT_CERT or None,
        )
        connect_args["ssl"] = ssl_context

    kwargs.update(
        {
            "pool_size": settings.DB_READ_POOL_SIZE if read_only else settings.DB_POOL_SIZE,
            "max_overflow": settings.DB_READ_MAX_OVERFLOW
            if read_only
            else settings.DB_MAX_OVERFLOW,
            "pool_timeout": settings.DB_POOL_TIMEOUT_SECONDS,
            "pool_use_lifo": settings.DB_POOL_USE_LIFO,
            "connect_args": connect_args,
        }
    )
    return kwargs


def _build_sync_engine_kwargs(url: str) -> dict:
    kwargs: dict = {
        "pool_size": settings.DB_SYNC_POOL_SIZE,
        "max_overflow": settings.DB_SYNC_MAX_OVERFLOW,
        "pool_pre_ping": True,
        "pool_recycle": settings.DB_POOL_RECYCLE_SECONDS,
    }
    if not _is_postgresql_url(url) or not settings.DB_REQUIRE_SSL:
        return kwargs

    connect_args = {
        "sslmode": "verify-full" if settings.DB_SSL_ROOT_CERT else "require",
    }
    if settings.DB_SSL_ROOT_CERT:
        connect_args["sslrootcert"] = settings.DB_SSL_ROOT_CERT
    kwargs["connect_args"] = connect_args
    return kwargs


engine = create_async_engine(
    settings.DATABASE_URL,
    **_build_engine_kwargs(settings.DATABASE_URL, read_only=False),
)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

if settings.DATABASE_READ_URL:
    read_engine = create_async_engine(
        settings.DATABASE_READ_URL,
        **_build_engine_kwargs(settings.DATABASE_READ_URL, read_only=True),
    )
    read_session_factory = async_sessionmaker(
        read_engine, class_=AsyncSession, expire_on_commit=False
    )
else:
    # If read-replica is not configured, reuse write session factory to avoid duplicate pools.
    read_engine = engine
    read_session_factory = async_session

# ---- Sync engine for Celery tasks (Celery doesn't support asyncio natively) ----
sync_engine = create_engine(
    settings.DATABASE_URL_SYNC,
    **_build_sync_engine_kwargs(settings.DATABASE_URL_SYNC),
)
SyncSession = sessionmaker(bind=sync_engine)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    """Write session — use for mutations (POST, PUT, DELETE)."""
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()


async def get_read_db() -> AsyncSession:
    """Read-only session — routed to replica if configured."""
    async with read_session_factory() as session:
        try:
            yield session
        finally:
            await session.close()


def _engine_is_postgresql() -> bool:
    return "postgresql" in str(engine.url)


@asynccontextmanager
async def serializable_session(fallback: AsyncSession | None = None):
    """SERIALIZABLE isolation session for critical batch operations.

    공정 배분 등 동시성에서 팬텀 리드가 결과를 훼손할 수 있는
    크리티컬 배치 작업에 사용합니다.

    On non-PostgreSQL backends (e.g. SQLite in tests), yields the
    *fallback* session instead so that tests sharing an in-memory
    database keep working.
    """
    if not _engine_is_postgresql():
        if fallback is None:
            async with async_session() as session:
                yield session
                await session.commit()
        else:
            yield fallback
        return

    async with engine.connect() as conn:
        await conn.execution_options(isolation_level="SERIALIZABLE")
        async with AsyncSession(bind=conn, expire_on_commit=False) as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
