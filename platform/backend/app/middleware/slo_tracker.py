"""SLO/SLI 추적 미들웨어 — Redis 시간별 버킷 기록.

요청마다 total/errors/latency_sum을 Redis Hash에 기록.
키: slo:{YYYY-MM-DD}:{HH} — TTL 35일 (월간 SLO 계산용).
"""

import logging
import time
from datetime import datetime, timezone

from starlette.requests import Request

logger = logging.getLogger(__name__)

_SLO_TTL_SECONDS = 35 * 24 * 3600  # 35일


class SLOTrackerMiddleware:
    """ASGI middleware for SLO/SLI tracking via Redis hourly buckets."""

    def __init__(self, app):  # noqa: ANN001
        self.app = app

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        # 헬스체크/메트릭은 SLO 집계에서 제외
        if path.startswith("/health") or path == "/metrics":
            await self.app(scope, receive, send)
            return

        start = time.perf_counter()
        status_code = 200

        async def send_wrapper(message):  # noqa: ANN001
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message.get("status", 200)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            status_code = 500
            raise
        finally:
            duration = time.perf_counter() - start
            is_error = status_code >= 500
            await _record_slo(duration, is_error)


async def _record_slo(duration: float, is_error: bool) -> None:
    """Redis Hash에 시간별 SLO 버킷 기록."""
    try:
        from app.core.redis import get_redis

        redis = get_redis()
        if redis is None:
            return

        now = datetime.now(timezone.utc)
        key = f"v2:slo:{now.strftime('%Y-%m-%d')}:{now.strftime('%H')}"

        pipe = redis.pipeline()
        pipe.hincrby(key, "total", 1)
        if is_error:
            pipe.hincrby(key, "errors", 1)
        pipe.hincrbyfloat(key, "latency_sum", round(duration, 6))
        # p99 근사: 느린 요청 카운트 (>2초)
        if duration > 2.0:
            pipe.hincrby(key, "slow_2s", 1)
        pipe.expire(key, _SLO_TTL_SECONDS)
        await pipe.execute()
    except Exception:
        logger.debug("SLO 기록 실패", exc_info=True)
