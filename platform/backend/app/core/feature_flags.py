"""Runtime feature flags backed by Redis with config.py fallback."""

import json
import logging
import time
from typing import Any

from app.core.config import settings
from app.core.redis import v2_key

logger = logging.getLogger(__name__)

# v2: prefix per DOMAIN_MODEL_STANDARD §7.
# Migration 2026-04-21: old key "pickket:feature_flags" is kept as a READ-ONLY
# fallback for 2 weeks so live feature flags don't flip during rollout.
# After 2026-05-05 the legacy key read path may be removed.
REDIS_KEY = v2_key("feature_flags")
_LEGACY_REDIS_KEY = "pickket:feature_flags"
_cache: dict[str, Any] = {}
_cache_ttl: float = 0


def _get_redis():
    """Get Redis connection (sync, via redis.asyncio decoded pool)."""
    try:
        from app.core.redis import get_redis

        return get_redis()
    except Exception:
        return None


async def get_feature_flag(key: str, default: Any = None) -> Any:
    """Get a feature flag value. Checks Redis first, then settings, then default."""
    global _cache, _cache_ttl

    # Check cache (10s TTL)
    now = time.time()
    if now - _cache_ttl < 10 and key in _cache:
        return _cache[key]

    # Try Redis — new v2-prefixed key first, legacy key as grace-window fallback
    redis = _get_redis()
    if redis:
        try:
            val = await redis.hget(REDIS_KEY, key)
            if val is None:
                val = await redis.hget(_LEGACY_REDIS_KEY, key)
            if val is not None:
                parsed = json.loads(val)
                _cache[key] = parsed
                _cache_ttl = now
                return parsed
        except Exception as e:
            logger.debug(f"Redis feature flag read failed: {e}")

    # Fallback to config.py settings
    config_val = getattr(settings, key.upper(), default)
    _cache[key] = config_val
    _cache_ttl = now
    return config_val


async def set_feature_flag(key: str, value: Any) -> bool:
    """Set a feature flag in Redis."""
    global _cache, _cache_ttl
    redis = _get_redis()
    if redis:
        try:
            await redis.hset(REDIS_KEY, key, json.dumps(value))
            _cache[key] = value
            _cache_ttl = 0  # Invalidate cache
            return True
        except Exception as e:
            logger.error(f"Redis feature flag write failed: {e}")
    return False


async def get_all_flags() -> dict[str, Any]:
    """Get all feature flags (merged: Redis overrides config defaults)."""
    defaults = {
        "resale_enabled": getattr(settings, "RESALE_ENABLED", False),
        "fanclub_presale_enabled": getattr(settings, "FANCLUB_PRESALE_ENABLED", True),
        "queue_enabled": getattr(settings, "QUEUE_ENABLED", True),
        "portone_mock_mode": getattr(settings, "PORTONE_MOCK_MODE", True),
        "feature_face_value_waitlist": getattr(settings, "FEATURE_FACE_VALUE_WAITLIST", False),
    }

    redis = _get_redis()
    if redis:
        try:
            # Merge legacy key first so new key values take precedence during grace window.
            for source_key in (_LEGACY_REDIS_KEY, REDIS_KEY):
                all_flags = await redis.hgetall(source_key)
                for k, v in all_flags.items():
                    key = k if isinstance(k, str) else k.decode()
                    defaults[key] = json.loads(v)
        except Exception:
            logger.debug("feature flag cache failed", exc_info=True)

    return defaults
