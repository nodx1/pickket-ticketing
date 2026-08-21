import logging
import time
import hmac

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_read_db
from app.middleware.auth import get_current_user
from app.core.ops_health import (
    BACKUP_MAX_AGE_SECONDS,
    BACKUP_LAST_RESULT_KEY,
    BACKUP_LAST_SUCCESS_KEY,
    BEAT_HEARTBEAT_KEY,
    BEAT_HEARTBEAT_MAX_AGE_SECONDS,
    decode_runtime_marker,
    marker_age_seconds,
)
from app.models.user import User
from app.schemas.admin import HealthDetailedResponse

router = APIRouter()
START_TIME = time.time()
logger = logging.getLogger(__name__)

_s3_client = None


def _get_s3_client():
    global _s3_client
    if _s3_client is None:
        import boto3

        client_kwargs = {
            "region_name": settings.S3_REGION,
            "aws_access_key_id": settings.S3_ACCESS_KEY,
            "aws_secret_access_key": settings.S3_SECRET_KEY,
        }
        if settings.S3_ENDPOINT_URL:
            client_kwargs["endpoint_url"] = settings.S3_ENDPOINT_URL
        _s3_client = boto3.client("s3", **client_kwargs)
    return _s3_client


def _has_valid_ops_token(request: Request) -> bool:
    provided_token = request.headers.get("x-pickket-ops-token", "")
    configured_token = settings.OPS_HEALTH_TOKEN.strip()
    return bool(
        configured_token
        and provided_token
        and hmac.compare_digest(provided_token, configured_token)
    )


@router.get("/sentry-debug")
async def sentry_debug():
    """Sentry 연동 검증용 — staging에서만 동작."""
    if settings.ENVIRONMENT not in ("staging", "development"):
        raise HTTPException(status_code=404, detail="Not Found")
    division_by_zero = 1 / 0  # noqa: F841


@router.get("/health/live")
async def live_health(db: AsyncSession = Depends(get_read_db)):
    """Lightweight liveness check for ALB. DB ping only."""
    try:
        await db.execute(text("SELECT 1"))
        return {"status": "ok"}
    except Exception:
        logger.warning("Live health: DB liveness check failed", exc_info=True)
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=503, content={"status": "unhealthy"})


async def _build_detailed_health(db: AsyncSession) -> HealthDetailedResponse:
    """Build the shared detailed health payload."""
    overall = "healthy"

    # ── Database ──────────────────────────────────────────────────
    db_info: dict = {"connected": False, "latency_ms": 0.0}
    try:
        t0 = time.monotonic()
        await db.execute(text("SELECT 1"))
        db_info["latency_ms"] = round((time.monotonic() - t0) * 1000, 2)
        db_info["connected"] = True
    except Exception:
        logger.warning("Detailed health: DB check failed", exc_info=True)
        overall = "degraded"

    # ── Read Replica ───────────────────────────────────────────────
    read_db_info: dict | None = None
    if settings.DATABASE_READ_URL:
        read_db_info = {"connected": False, "latency_ms": 0.0, "is_separate": True}
        try:
            from app.core.database import read_session_factory

            async with read_session_factory() as read_session:
                t0 = time.monotonic()
                await read_session.execute(text("SELECT 1"))
                read_db_info["latency_ms"] = round((time.monotonic() - t0) * 1000, 2)
                read_db_info["connected"] = True
        except Exception:
            logger.warning("Detailed health: Read DB check failed", exc_info=True)
            overall = "degraded"

    # ── Redis ─────────────────────────────────────────────────────
    redis_info: dict = {"connected": False, "latency_ms": 0.0}
    scheduler_info: dict = {
        "status": "unknown",
        "last_heartbeat_at": None,
        "age_seconds": None,
    }
    backup_info: dict = {
        "status": "unknown",
        "last_success_at": None,
        "age_seconds": None,
        "backup_id": None,
        "last_error": None,
        "last_result_at": None,
    }
    try:
        from app.core.redis import get_redis

        redis = get_redis()
        t0 = time.monotonic()
        await redis.ping()
        redis_info["latency_ms"] = round((time.monotonic() - t0) * 1000, 2)
        redis_info["connected"] = True

        beat_marker = decode_runtime_marker(await redis.get(BEAT_HEARTBEAT_KEY))
        beat_age = marker_age_seconds(beat_marker)
        if beat_marker is not None:
            scheduler_info["last_heartbeat_at"] = beat_marker.get("recorded_at")
            scheduler_info["age_seconds"] = beat_age
            scheduler_info["status"] = (
                "ok"
                if beat_age is not None and beat_age <= BEAT_HEARTBEAT_MAX_AGE_SECONDS
                else "stale"
            )
            if scheduler_info["status"] != "ok":
                overall = "degraded"
        else:
            # #31: heartbeat key absent. The key has a 900s TTL, so a missing
            # key means beat has been down for >15min (TTL expired) — a *worse*
            # outage than a stale-but-present marker. Previously this left
            # status="unknown" and overall="healthy", inverting severity: the
            # longer beat stayed down, the healthier we reported. Treat the
            # absence as a hard failure so monitoring fires.
            scheduler_info["status"] = "down"
            overall = "degraded"

        backup_success = decode_runtime_marker(await redis.get(BACKUP_LAST_SUCCESS_KEY))
        backup_result = decode_runtime_marker(await redis.get(BACKUP_LAST_RESULT_KEY))
        backup_age = marker_age_seconds(backup_success)
        if backup_success is not None:
            backup_info["last_success_at"] = backup_success.get("recorded_at")
            backup_info["age_seconds"] = backup_age
            backup_info["backup_id"] = backup_success.get("backup_id")
            backup_info["status"] = (
                "ok" if backup_age is not None and backup_age <= BACKUP_MAX_AGE_SECONDS else "stale"
            )
            if backup_info["status"] != "ok":
                overall = "degraded"
        if backup_result is not None:
            backup_info["last_result_at"] = backup_result.get("recorded_at")
            if backup_result.get("status") == "failure":
                backup_info["status"] = "error"
                backup_info["last_error"] = backup_result.get("error")
                overall = "degraded"
    except Exception:
        logger.warning("Detailed health: Redis check failed", exc_info=True)
        overall = "degraded"

    # ── Object storage (S3 / R2) ────────────────────────────────
    s3_ok = False
    s3_latency = None
    if settings.UPLOAD_PROVIDER == "s3":
        try:
            s3_start = time.monotonic()
            s3_client = _get_s3_client()
            s3_client.head_bucket(Bucket=settings.S3_BUCKET)
            s3_latency = round((time.monotonic() - s3_start) * 1000, 1)
            s3_ok = True
        except Exception as s3_exc:  # noqa: BLE001
            logger.warning("S3 health check failed: %s", s3_exc)
            overall = "degraded"
    else:
        s3_ok = True

    # ── Celery (async — 이벤트 루프 차단 방지) ─────────────────
    celery_info: dict = {"workers": 0, "active_tasks": 0}
    try:
        import asyncio
        from app.core.celery_app import celery_app

        def _check_celery() -> dict:
            insp = celery_app.control.inspect(timeout=2)
            active = insp.active() or {}
            return {
                "workers": len(active),
                "active_tasks": sum(len(t) for t in active.values()),
            }

        celery_info = await asyncio.to_thread(_check_celery)
    except Exception:
        logger.warning("Detailed health: Celery check failed", exc_info=True)

    # ── Uptime ────────────────────────────────────────────────────
    uptime = time.time() - START_TIME

    # ── Error count (24h) ──
    # Source: Redis sorted set `v2:health:errors:24h` populated by Sentry
    # before_send hook (incremented on every error event). If the key is
    # absent (Redis down, hook not firing), return -1 to signal "unknown"
    # instead of silently reporting 0 errors.
    error_count_24h: int = -1
    try:
        from app.core.redis import get_redis as _get_redis_health

        _r = _get_redis_health()
        if _r is not None:
            # Trim entries older than 24h, then count remaining.
            cutoff = time.time() - 86400
            await _r.zremrangebyscore("v2:health:errors:24h", 0, cutoff)
            error_count_24h = int(await _r.zcard("v2:health:errors:24h"))
    except Exception:
        logger.debug("error_count_24h lookup failed — reporting unknown", exc_info=True)

    if not db_info["connected"] and not redis_info["connected"]:
        overall = "unhealthy"

    return HealthDetailedResponse(
        status=overall,
        database=db_info,
        database_read=read_db_info,
        redis=redis_info,
        storage={
            "status": "ok" if s3_ok else "error",
            "provider": settings.UPLOAD_PROVIDER,
            "latency_ms": s3_latency,
        },
        celery=celery_info,
        scheduler=scheduler_info,
        backup=backup_info,
        uptime_seconds=round(uptime, 1),
        error_count_24h=error_count_24h,
    )


@router.get("/health/detailed", response_model=HealthDetailedResponse)
async def detailed_health(request: Request, db: AsyncSession = Depends(get_read_db)):
    """Detailed ops health check. Token-only outside development."""
    if settings.ENVIRONMENT != "development" and not _has_valid_ops_token(request):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return await _build_detailed_health(db)


@router.get("/admin/system/health", response_model=HealthDetailedResponse)
async def admin_system_health(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Authenticated admin health endpoint for the admin portal."""
    if not current_user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return await _build_detailed_health(db)
