"""계정 잠금 + CAPTCHA 서비스.

인터파크 2023 크리덴셜 스터핑 대비:
- 계정별 실패 카운터 (Redis)
- 3회 실패 → CAPTCHA 요구
- 5회 실패 → 15분 잠금 (지수 백오프)
- 10회 이상 → Telegram 알림
"""
import hashlib
import logging

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

_CAPTCHA_THRESHOLD = 3
_ALERT_THRESHOLD = 10


def _email_hash(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()[:20]


async def check_lockout(email: str) -> dict:
    """계정 잠금 상태 확인.

    Returns: {"locked": bool, "remaining_seconds": int, "fail_count": int}
    """
    # 통합 E2E(Playwright)는 계정잠금 대상에서 제외 — auth-security 스펙의 의도적 오답 폭격이
    # 시드 계정을 잠가 전체 e2e 를 오염시키는 문제 방지(captcha 우회와 대칭, config.py:131 의도).
    if settings.E2E_TEST_MODE:
        return {"locked": False, "remaining_seconds": 0, "fail_count": 0}
    try:
        from app.core.redis import get_redis
        redis = get_redis()
        eh = _email_hash(email)

        lock_ttl = await redis.ttl(f"v2:login:lock:{eh}")
        if lock_ttl and lock_ttl > 0:
            return {"locked": True, "remaining_seconds": lock_ttl, "fail_count": 0}

        fail_count = await redis.get(f"v2:login:fail:{eh}")
        return {
            "locked": False,
            "remaining_seconds": 0,
            "fail_count": int(fail_count) if fail_count else 0,
        }
    except Exception:
        logger.warning("Lockout check failed — treating as locked for safety", exc_info=True)
        return {"locked": True, "remaining_seconds": 60, "fail_count": 0}  # fail-closed


async def record_login_failure(email: str) -> int:
    """로그인 실패 기록. 임계값 초과 시 잠금. 실패 횟수 반환."""
    try:
        from app.core.redis import get_redis
        redis = get_redis()
        eh = _email_hash(email)
        fail_key = f"v2:login:fail:{eh}"
        lock_key = f"v2:login:lock:{eh}"

        # Lua script: atomic incr + expire to prevent TTL-less keys on crash
        _LUA_INCR_EX = """
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c
"""
        count = await redis.eval(_LUA_INCR_EX, 1, fail_key, 900)

        threshold = settings.ACCOUNT_LOCKOUT_THRESHOLD

        if count >= threshold:
            # 지수 백오프: 15 → 30 → 60분
            lockout_round = (count - threshold) // threshold
            duration = min(
                settings.ACCOUNT_LOCKOUT_DURATION_MINUTES * (2 ** lockout_round),
                60,
            ) * 60
            await redis.setex(lock_key, duration, "1")
            logger.warning(
                "Account locked: %s (failures=%d, duration=%ds)", eh, count, duration
            )

        if count >= _ALERT_THRESHOLD and count % 5 == 0:
            try:
                from app.core.alerting import send_ops_alert
                await send_ops_alert(
                    f"🚨 대량 로그인 실패 탐지\n"
                    f"이메일 해시: {eh}\n"
                    f"실패 횟수: {count}회",
                    level="critical",
                    alert_key=f"lockout:{eh}",
                )
            except Exception:
                logger.debug("lockout alert delivery failed", exc_info=True)

        return count
    except Exception:
        logger.warning("Failed to record login failure", exc_info=True)
        return 0


async def reset_login_failures(email: str) -> None:
    """로그인 성공 시 실패 카운터 초기화."""
    try:
        from app.core.redis import get_redis
        redis = get_redis()
        eh = _email_hash(email)
        pipe = redis.pipeline()
        pipe.delete(f"v2:login:fail:{eh}")
        pipe.delete(f"v2:login:lock:{eh}")
        await pipe.execute()
    except Exception:
        logger.debug("Failed to reset login failures", exc_info=True)


def is_captcha_required(fail_count: int) -> bool:
    """CAPTCHA 필요 여부."""
    if settings.E2E_TEST_MODE:
        return False
    return fail_count >= _CAPTCHA_THRESHOLD


async def verify_captcha(token: str | None) -> bool:
    """Cloudflare Turnstile CAPTCHA 검증."""
    if not token:
        return False

    secret = settings.CAPTCHA_SECRET_KEY
    if not secret:
        # CAPTCHA 미설정 시 통과 (개발 환경)
        return True

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                "https://challenges.cloudflare.com/turnstile/v0/siteverify",
                data={"secret": secret, "response": token},
            )
            result = resp.json()
            return result.get("success", False)
    except Exception:
        logger.warning("CAPTCHA verification failed", exc_info=True)
        return False  # fail-closed


# auth.py uses these aliases
record_failure = record_login_failure
reset_on_success = reset_login_failures
