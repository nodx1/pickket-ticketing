"""Distributed rate limiting using Redis sorted sets (ZSET).

Each request is recorded as a member in a sorted set keyed by
``rate_limit:{name}:{client_ip}``.  The score is the request timestamp.
On each check we:

1. Remove entries older than the current window (ZREMRANGEBYSCORE).
2. Count remaining entries (ZCARD).
3. If under the limit, add the current timestamp (ZADD) and set TTL.

All three steps run inside a Redis pipeline for atomicity and efficiency.

If Redis is unavailable the limiter degrades gracefully: requests are
allowed through with a logged warning.  The Redis circuit breaker
(``app.core.redis._redis_breaker``) prevents repeated connection attempts
when Redis is known to be down, reducing latency on every request.
"""

from __future__ import annotations

import hmac
import logging
import time
from collections import defaultdict
from threading import Lock as ThreadLock

from fastapi import HTTPException, Request, status

from app.core.config import settings
from app.core.network import extract_client_ip  # noqa: F401 — re-exported for backward compat
from app.core.resilience import CircuitBreakerOpen
from app.core.security import decode_access_token_payload

logger = logging.getLogger(__name__)

# --- 인메모리 폴백 (Redis 장애 대비) ---
_INMEMORY_MAX = 200  # Redis 장애 시 인메모리 제한 (관대)
_INMEMORY_WINDOW = 60  # 60초 윈도우
_inmemory_counters: dict[str, list[float]] = defaultdict(list)
_inmemory_lock = ThreadLock()


def _inmemory_check(key: str, max_requests: int | None = None) -> bool:
    """인메모리 폴백 rate limit. True=허용, False=차단."""
    limit = max_requests or _INMEMORY_MAX
    now = time.time()
    cutoff = now - _INMEMORY_WINDOW

    with _inmemory_lock:
        # Lazy cleanup: 오래된 항목 제거
        entries = _inmemory_counters[key]
        _inmemory_counters[key] = [t for t in entries if t > cutoff]

        if len(_inmemory_counters[key]) >= limit:
            return False
        _inmemory_counters[key].append(now)

        # 메모리 폭발 방지: 키 수 제한
        if len(_inmemory_counters) > 10000:
            oldest_keys = sorted(
                _inmemory_counters.keys(),
                key=lambda k: _inmemory_counters[k][-1] if _inmemory_counters[k] else 0,
            )[:5000]
            for k in oldest_keys:
                del _inmemory_counters[k]

    return True


def _get_redis_breaker():
    """Lazy import to avoid circular dependency at module level."""
    from app.core.redis import _redis_breaker
    return _redis_breaker


class RedisRateLimiter:
    """Async, Redis-backed sliding-window rate limiter.

    Integrates with the shared Redis circuit breaker so that when Redis
    is confirmed down, rate-limit checks return immediately with the
    configured degradation policy (fail-open by default) instead of
    waiting for a connection timeout on every request.
    """

    def __init__(
        self,
        name: str,
        max_requests: int = 60,
        window_seconds: int = 60,
        *,
        fail_closed: bool = False,
    ):
        self.name = name
        self.max_requests = max_requests
        self.window = window_seconds
        self.fail_closed = fail_closed

    def _fail_open_result_2(self, key: str = "") -> tuple[bool, int]:
        """Degradation result for check() — 인메모리 폴백 적용."""
        if self.fail_closed:
            return (False, 0)
        # fail_closed=False여도 인메모리 폴백으로 기본 방어
        if key and not _inmemory_check(f"{self.name}:{key}", _INMEMORY_MAX):
            logger.warning("In-memory rate limit hit for %s:%s", self.name, key)
            return (False, 0)
        return (True, self.max_requests)

    def _fail_open_result_3(self, key: str = "") -> tuple[bool, int, int]:
        """Degradation result for is_allowed() — 인메모리 폴백 적용."""
        if self.fail_closed:
            return (False, 0, self.window)
        if key and not _inmemory_check(f"{self.name}:{key}", _INMEMORY_MAX):
            logger.warning("In-memory rate limit hit for %s:%s", self.name, key)
            return (False, 0, _INMEMORY_WINDOW)
        return (True, self.max_requests, 0)

    async def check(self, key: str) -> tuple[bool, int]:
        """Return ``(allowed, remaining)`` tuple.

        ``allowed`` is ``True`` if the request is permitted, ``False`` if
        rate-limited.  ``remaining`` is the approximate number of requests
        left in the current window.

        By default falls back to allowing requests if Redis is unreachable.
        For high-risk endpoints ``fail_closed=True`` can be enabled.

        Circuit breaker: when open, skips Redis entirely and degrades
        according to ``fail_closed`` policy.
        """
        breaker = _get_redis_breaker()
        try:
            await breaker.before_call()
        except CircuitBreakerOpen:
            logger.debug(
                "Rate limit check skipped (circuit open) for %s — %s",
                self.name,
                "blocking" if self.fail_closed else "allowing",
            )
            return self._fail_open_result_2(key)

        try:
            from app.core.redis import get_redis

            redis = get_redis()
        except RuntimeError:
            logger.warning(
                "Redis unavailable for rate limiting (%s) — %s",
                self.name,
                "blocking request" if self.fail_closed else "allowing request through",
            )
            return self._fail_open_result_2(key)

        redis_key = f"v2:rate_limit:{self.name}:{key}"
        now = time.time()
        window_start = now - self.window

        try:
            # Atomic sliding-window check via Lua to avoid race conditions.
            script = """
local key = KEYS[1]
local window_start = tonumber(ARGV[1])
local max_requests = tonumber(ARGV[2])
local ttl_seconds = tonumber(ARGV[3])
local score = tonumber(ARGV[4])
local member = ARGV[5]

redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)
local current = redis.call('ZCARD', key)
if current >= max_requests then
  redis.call('EXPIRE', key, ttl_seconds)
  return {0, 0}
end
redis.call('ZADD', key, score, member)
redis.call('EXPIRE', key, ttl_seconds)
return {1, max_requests - current - 1}
"""
            member = f"{now}:{time.time_ns()}"
            result = await redis.eval(
                script,
                1,
                redis_key,
                window_start,
                self.max_requests,
                self.window,
                now,
                member,
            )
            await breaker.on_success()
            if isinstance(result, list):
                return (bool(int(result[0])), int(result[1]))
            return (bool(int(result)), self.max_requests)  # fallback
        except Exception:
            await breaker.on_failure()
            logger.warning(
                "Redis error during rate limit check (%s) — %s",
                self.name,
                "blocking request" if self.fail_closed else "allowing request through",
                exc_info=True,
            )
            return self._fail_open_result_2(key)

    async def remaining(self, key: str) -> int:
        """Return approximate number of requests remaining in the current window."""
        breaker = _get_redis_breaker()
        try:
            await breaker.before_call()
        except CircuitBreakerOpen:
            return self.max_requests

        try:
            from app.core.redis import get_redis

            redis = get_redis()
        except RuntimeError:
            return self.max_requests

        redis_key = f"v2:rate_limit:{self.name}:{key}"
        now = time.time()
        window_start = now - self.window

        try:
            pipe = redis.pipeline(transaction=True)
            pipe.zremrangebyscore(redis_key, "-inf", window_start)
            pipe.zcard(redis_key)
            results = await pipe.execute()
            count = results[1]
            await breaker.on_success()
            return max(0, self.max_requests - count)
        except Exception:
            await breaker.on_failure()
            logger.debug(
                "Redis error while calculating remaining rate limit (%s)",
                self.name,
                exc_info=True,
            )
            return self.max_requests

    async def is_allowed(self, key: str) -> tuple[bool, int, int]:
        """Return allow decision with remaining budget and retry-after seconds."""
        breaker = _get_redis_breaker()
        try:
            await breaker.before_call()
        except CircuitBreakerOpen:
            logger.debug(
                "Rate limit is_allowed skipped (circuit open) for %s — %s",
                self.name,
                "blocking" if self.fail_closed else "allowing",
            )
            return self._fail_open_result_3(key)

        try:
            from app.core.redis import get_redis

            redis = get_redis()
        except RuntimeError:
            logger.warning(
                "Redis unavailable for rate limiting (%s) — %s",
                self.name,
                "blocking request" if self.fail_closed else "allowing request through",
            )
            return self._fail_open_result_3(key)

        redis_key = f"v2:rate_limit:{self.name}:{key}"
        now = time.time()
        window_start = now - self.window

        try:
            pipe = redis.pipeline(transaction=True)
            pipe.zremrangebyscore(redis_key, "-inf", window_start)
            pipe.zcard(redis_key)
            results = await pipe.execute()
            current = int(results[1])

            if current >= self.max_requests:
                await breaker.on_success()
                return (False, 0, self.window)

            write_pipe = redis.pipeline(transaction=True)
            member = f"{now}:{time.time_ns()}"
            write_pipe.zadd(redis_key, {member: now})
            write_pipe.expire(redis_key, self.window)
            await write_pipe.execute()
            await breaker.on_success()
            remaining = max(0, self.max_requests - (current + 1))
            return (True, remaining, 0)
        except Exception:
            await breaker.on_failure()
            logger.warning(
                "Redis error during rate limit check (%s) — %s",
                self.name,
                "blocking request" if self.fail_closed else "allowing request through",
                exc_info=True,
            )
            return self._fail_open_result_3(key)


# ---------------------------------------------------------------------------
# Global limiter instances
# ---------------------------------------------------------------------------

# E2E 테스트 / 개발 환경에서는 auth rate limit 완화
_auth_max = 1000 if settings.E2E_TEST_MODE else (60 if settings.ENVIRONMENT == "development" else 5)

_general_max = 600 if settings.ENVIRONMENT == "development" else 200
general_limiter = RedisRateLimiter(name="general", max_requests=_general_max, window_seconds=60)
bid_limiter = RedisRateLimiter(name="bid", max_requests=10, window_seconds=60)
auth_limiter = RedisRateLimiter(
    name="auth", max_requests=_auth_max, window_seconds=60, fail_closed=True
)
payment_limiter = RedisRateLimiter(
    name="payment", max_requests=20, window_seconds=60, fail_closed=True
)
checkin_limiter = RedisRateLimiter(
    name="checkin", max_requests=30, window_seconds=60, fail_closed=True
)
webhook_limiter = RedisRateLimiter(
    name="webhook", max_requests=120, window_seconds=60, fail_closed=True
)
purchase_user_limiter = RedisRateLimiter(
    name="purchase_user",
    max_requests=10,
    window_seconds=60,
    fail_closed=True,
)
password_reset_limiter = RedisRateLimiter(
    name="pwd_reset",
    max_requests=5,
    window_seconds=3600,  # 5 per hour per IP
    fail_closed=True,
)
password_reset_email_limiter = RedisRateLimiter(
    name="pwd_reset_email",
    max_requests=3,
    window_seconds=3600,  # 3 per hour per email — prevents targeted account lockout
    fail_closed=True,
)
sms_limiter = RedisRateLimiter(
    name="sms",
    max_requests=3,
    window_seconds=600,  # 3 per 10 minutes
    fail_closed=True,
)
upload_limiter = RedisRateLimiter(
    name="upload",
    max_requests=20,
    window_seconds=600,
    fail_closed=True,
)


# ---------------------------------------------------------------------------
# FastAPI dependency functions
# ---------------------------------------------------------------------------


async def rate_limit_general(request: Request):
    key = extract_client_ip(request)
    allowed, _ = await general_limiter.check(key)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests. Please try again later.",
        )


async def rate_limit_bid(request: Request):
    key = extract_client_ip(request)
    allowed, _ = await bid_limiter.check(key)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many bid requests. Please wait before trying again.",
        )


def _is_internal_service_call(request: Request) -> bool:
    """`X-Pickket-Service-Token` 이 유효한 **서버간 호출**인가(timing-safe).

    🔴 2026-07-27 prod 실장애 배경:
      `rate_limit_auth` 는 `/auth/*` **라우터 전체**에 걸려 있고(router.py:86) 한도는
      production 기준 **분당 5회**·키는 `extract_client_ip`. 그런데 organizer(go) 컨테이너에서
      오는 호출은 **전부 같은 컨테이너 IP** 라 앱 하나가 5회를 통째로 공유한다.
      `/auth/verify-token` 은 organizer 가 **매 요청마다** 호출(세션 해석)하므로 페이지 한 번
      열면 즉시 소진 → 429 → 세션 해석 실패 → 401 → **로그인 직후 자동 로그아웃**.
      `/auth/login` 도 organizer 가 프록시하므로 **모든 사용자의 로그인이 같은 5회 버킷**을 썼다.

      `extract_client_ip` 는 신뢰 프록시(TRUSTED_PROXY_CIDRS)에서 온 경우에만 X-Forwarded-For 를
      믿는데, 내부 서비스 컨테이너는 그 목록에 없어 organizer 가 전달한 원 클라이언트 IP 가
      무시된다 — 즉 IP 기준 분리가 애초에 불가능한 구조였다.

    ⟹ 서비스 토큰으로 **이미 인증된** 서버간 호출은 소비자용 IP 리밋 대상이 아니다.
       토큰이 없거나 틀리면 종전대로 리밋을 받는다(헤더 이름만 안다고 우회되지 않음).
    """
    token = request.headers.get("x-pickket-service-token", "")
    expected = settings.internal_service_token or ""
    return bool(token and expected and hmac.compare_digest(token, expected))


async def rate_limit_auth(request: Request):
    # 서버간 호출은 소비자용 IP 리밋에서 제외(위 설명).
    if _is_internal_service_call(request):
        return
    key = extract_client_ip(request)
    allowed, _ = await auth_limiter.check(key)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many auth requests. Please wait before trying again.",
        )


async def rate_limit_payment(request: Request):
    key = extract_client_ip(request)
    allowed, _ = await payment_limiter.check(key)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many payment requests. Please wait before trying again.",
        )


async def rate_limit_checkin(request: Request):
    key = extract_client_ip(request)
    allowed, _ = await checkin_limiter.check(key)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many check-in requests. Please wait before trying again.",
        )


async def rate_limit_webhook(request: Request):
    key = extract_client_ip(request)
    allowed, _ = await webhook_limiter.check(key)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many webhook requests. Please retry shortly.",
        )


async def rate_limit_password_reset(request: Request):
    key = extract_client_ip(request)
    allowed, _ = await password_reset_limiter.check(key)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many password reset requests. Please try again later.",
        )


async def rate_limit_sms(request: Request):
    key = extract_client_ip(request)
    allowed, _ = await sms_limiter.check(key)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many SMS requests. Please wait before trying again.",
        )


async def rate_limit_upload(request: Request):
    """Rate limit for image upload endpoints."""
    user = getattr(request.state, "user", None)
    if user and getattr(user, "id", None):
        identifier = f"user:{user.id}"
    else:
        identifier = None
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            payload = decode_access_token_payload(auth[7:])
            if payload and payload.get("sub"):
                identifier = f"user:{payload['sub']}"
        if identifier is None:
            identifier = extract_client_ip(request)

    allowed, _remaining, retry_after = await upload_limiter.is_allowed(identifier)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Upload rate limit exceeded. Try again later.",
            headers={"Retry-After": str(retry_after)},
        )


async def rate_limit_purchase_by_user(request: Request):
    """Per-user rate limit for purchase/resale endpoints.

    Falls back to IP-based if user not authenticated.
    """
    try:
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
            payload = decode_access_token_payload(token)
            if not payload:
                raise ValueError("invalid token")
            user_id = payload.get("sub")
            if user_id:
                allowed, _ = await purchase_user_limiter.check(f"user:{user_id}")
                if not allowed:
                    raise HTTPException(
                        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                        detail="Too many purchase requests",
                    )
                return
    except HTTPException:
        raise
    except Exception:
        logger.debug("Purchase limiter falling back to IP-based key", exc_info=True)
    # Fallback to IP
    key = extract_client_ip(request)
    allowed, _ = await purchase_user_limiter.check(key)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many purchase requests",
        )
