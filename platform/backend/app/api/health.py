"""Kubernetes-style health check endpoints: liveness, readiness, and legacy.

- GET /health/live  -- process alive (always 200)
- GET /health/ready -- DB + Redis + migration head check
- GET /health       -- legacy (same as /health/ready)
"""

import asyncio
from functools import lru_cache
import logging
from pathlib import Path

from fastapi import APIRouter, status
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.redis import get_redis, is_redis_circuit_open, redis_health_check

logger = logging.getLogger(__name__)

health_router = APIRouter(tags=["health"])


@lru_cache(maxsize=1)
def _expected_alembic_heads() -> frozenset[str]:
    """배포된 코드 번들이 요구하는 Alembic head 집합을 반환한다(multi-head 안전)."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    backend_root = Path(__file__).resolve().parents[2]
    config = Config(str(backend_root / "alembic.ini"))
    return frozenset(ScriptDirectory.from_config(config).get_heads())


@health_router.get("/health/live")
async def liveness():
    """Liveness probe — always returns 200 if the process is running."""
    return {"status": "alive"}


async def _check_readiness() -> dict:
    """Shared readiness logic for /health/ready and /health."""
    result: dict = {
        "status": "ok",
        "database": "ok",
        "redis": "ok",
        "migrations": "ok",
    }
    degraded = False

    # Check database (with 3s timeout)
    try:
        from app.core.database import engine
        import sqlalchemy

        async with asyncio.timeout(5):
            async with engine.connect() as conn:
                await conn.execute(sqlalchemy.text("SELECT 1"))
    except Exception:
        result["database"] = "unavailable"
        degraded = True
        logger.warning("Health check: database ping failed", exc_info=True)

    # Check Redis (with 5s timeout) — also updates circuit breaker state
    try:
        async with asyncio.timeout(5):
            redis_ok = await redis_health_check()
        if not redis_ok:
            result["redis"] = "unavailable"
            degraded = True
        if is_redis_circuit_open():
            result["redis_circuit"] = "open"
    except Exception:
        result["redis"] = "unavailable"
        degraded = True
        logger.warning("Health check: Redis ping failed", exc_info=True)

    # Check exact Alembic migration heads. 테이블 접근 가능 여부만 확인하면 새 ORM 컬럼보다
    # DB가 뒤처진 상태도 ready=200이 되어 런타임 500을 낸다. multi-head 집합을 정확히 비교한다.
    try:
        from app.core.database import engine
        import sqlalchemy

        expected_heads = set(_expected_alembic_heads())
        async with asyncio.timeout(5):
            async with engine.connect() as conn:
                row = await conn.execute(
                    sqlalchemy.text("SELECT version_num FROM alembic_version")
                )
                database_heads = {str(value) for value in row.scalars().all()}
        if database_heads != expected_heads:
            result["migrations"] = {
                "status": "out_of_date",
                "expected_heads": sorted(expected_heads),
                "database_heads": sorted(database_heads),
            }
            degraded = True
            logger.error(
                "Health check: Alembic head mismatch expected=%s database=%s",
                sorted(expected_heads),
                sorted(database_heads),
            )
    except Exception:
        result["migrations"] = "unavailable"
        degraded = True
        logger.warning("Health check: Alembic head check failed", exc_info=True)

    if degraded:
        result["status"] = "degraded"

    return result


@health_router.get("/health/ready")
async def readiness():
    """Readiness probe — checks DB, Redis, and migration status."""
    result = await _check_readiness()
    if result["status"] != "ok":
        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content=result)
    return result


@health_router.get("/health")
async def health_legacy():
    """Legacy health endpoint — equivalent to /health/ready."""
    result = await _check_readiness()
    if result["status"] != "ok":
        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content=result)
    return result
