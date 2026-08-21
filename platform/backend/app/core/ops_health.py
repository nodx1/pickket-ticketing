"""Runtime health markers for scheduler and backup operations."""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from app.core.config import settings
from app.core.redis import build_redis_connection_kwargs

logger = logging.getLogger(__name__)

BEAT_HEARTBEAT_KEY = "ops:celery:beat:last_heartbeat"
BACKUP_LAST_RESULT_KEY = "ops:backup:last_result"
BACKUP_LAST_SUCCESS_KEY = "ops:backup:last_success"

BEAT_HEARTBEAT_TTL_SECONDS = 900
BEAT_HEARTBEAT_MAX_AGE_SECONDS = 180
BACKUP_MAX_AGE_SECONDS = 36 * 3600


def utc_now_ts() -> float:
    return time.time()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_sync_redis_client():
    import redis

    url = settings.REDIS_URL.split("?")[0]
    kwargs: dict[str, Any] = build_redis_connection_kwargs(url)
    return redis.Redis.from_url(url, **kwargs)


def _store_json_sync(key: str, payload: dict[str, Any], *, ex: int | None = None) -> None:
    client = None
    try:
        client = _build_sync_redis_client()
        encoded = json.dumps(payload, default=str)
        if ex is not None:
            client.setex(key, ex, encoded)
        else:
            client.set(key, encoded)
    except Exception:
        logger.warning("Failed to persist ops health marker: %s", key, exc_info=True)
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


def record_beat_heartbeat_sync() -> None:
    _store_json_sync(
        BEAT_HEARTBEAT_KEY,
        {
            "status": "ok",
            "timestamp": utc_now_ts(),
            "recorded_at": utc_now_iso(),
        },
        ex=BEAT_HEARTBEAT_TTL_SECONDS,
    )


def record_backup_success_sync(backup_id: str) -> None:
    payload = {
        "status": "success",
        "timestamp": utc_now_ts(),
        "recorded_at": utc_now_iso(),
        "backup_id": backup_id,
    }
    _store_json_sync(BACKUP_LAST_RESULT_KEY, payload)
    _store_json_sync(BACKUP_LAST_SUCCESS_KEY, payload)


def record_backup_failure_sync(error: str) -> None:
    _store_json_sync(
        BACKUP_LAST_RESULT_KEY,
        {
            "status": "failure",
            "timestamp": utc_now_ts(),
            "recorded_at": utc_now_iso(),
            "error": error[:300],
        },
    )


def decode_runtime_marker(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def marker_age_seconds(marker: dict[str, Any] | None, now_ts: float | None = None) -> float | None:
    if not marker:
        return None
    timestamp = marker.get("timestamp")
    if not isinstance(timestamp, (int, float)):
        return None
    now = now_ts if now_ts is not None else utc_now_ts()
    return max(0.0, round(now - float(timestamp), 2))
