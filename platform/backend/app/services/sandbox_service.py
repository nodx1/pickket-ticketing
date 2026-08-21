"""P3-12: Sandbox service for API testing.

Provides isolated sandbox environment:
- Separate namespace in Redis for sandbox data
- Mock payment processing
- Rate limiting relaxed for testing
- Request/response logging for debugging
"""

import uuid
from datetime import datetime, timezone
import json

from app.core.redis import get_redis


SANDBOX_PREFIX = "v2:sandbox:"
SANDBOX_TTL = 86400  # 24 hours


async def is_sandbox_request(api_key: str) -> bool:
    """Check if an API key belongs to sandbox environment."""
    return api_key.startswith("pk_sandbox_") or api_key.startswith("sk_sandbox_")


async def create_sandbox_api_key(user_id: str) -> dict:
    """Create a sandbox API key for testing."""
    redis = get_redis()
    if redis is None:
        return {"error": "Redis unavailable"}

    key_id = str(uuid.uuid4())[:12]
    api_key = f"pk_sandbox_{key_id}"
    secret_key = f"sk_sandbox_{key_id}"

    try:
        await redis.hset(f"{SANDBOX_PREFIX}keys:{api_key}", mapping={
            "user_id": user_id,
            "secret_key": secret_key,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "requests_count": "0",
        })
        await redis.expire(f"{SANDBOX_PREFIX}keys:{api_key}", SANDBOX_TTL * 30)  # 30 days

        return {
            "api_key": api_key,
            "secret_key": secret_key,
            "base_url": "https://sandbox.api.pickket.kr/api/v1",
            "expires_in_days": 30,
        }
    except Exception as e:
        return {"error": str(e)}


async def log_sandbox_request(
    api_key: str,
    method: str,
    path: str,
    status: int,
    request_body: dict | None = None,
    response_body: dict | None = None,
) -> None:
    """Log a sandbox API request for debugging."""
    redis = get_redis()
    if redis is None:
        return

    try:
        log_entry = {
            "method": method,
            "path": path,
            "status": status,
            "request": request_body,
            "response": response_body,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        log_key = f"{SANDBOX_PREFIX}logs:{api_key}"
        await redis.lpush(log_key, json.dumps(log_entry, default=str))
        await redis.ltrim(log_key, 0, 99)  # Keep last 100 requests
        await redis.expire(log_key, SANDBOX_TTL)

        # Increment request counter
        await redis.hincrby(f"{SANDBOX_PREFIX}keys:{api_key}", "requests_count", 1)
    except Exception:
        pass


async def get_sandbox_logs(api_key: str, limit: int = 50) -> list[dict]:
    """Get recent sandbox request logs."""
    redis = get_redis()
    if redis is None:
        return []

    try:
        log_key = f"{SANDBOX_PREFIX}logs:{api_key}"
        entries = await redis.lrange(log_key, 0, limit - 1)
        return [
            json.loads(e.decode() if isinstance(e, bytes) else e)
            for e in entries
        ]
    except Exception:
        return []


async def mock_payment(
    amount: int,
    currency: str = "KRW",
    should_fail: bool = False,
) -> dict:
    """Mock payment processing for sandbox."""
    if should_fail:
        return {
            "success": False,
            "error": "SANDBOX_PAYMENT_DECLINED",
            "message": "This is a simulated payment failure for testing",
        }

    return {
        "success": True,
        "payment_id": f"sandbox_pay_{uuid.uuid4().hex[:12]}",
        "amount": amount,
        "currency": currency,
        "status": "CONFIRMED",
        "message": "Sandbox payment processed successfully (no real charge)",
    }


async def reset_sandbox(api_key: str) -> bool:
    """Reset all sandbox data for an API key."""
    redis = get_redis()
    if redis is None:
        return False

    try:
        # Delete logs
        await redis.delete(f"{SANDBOX_PREFIX}logs:{api_key}")
        # Reset counter
        await redis.hset(f"{SANDBOX_PREFIX}keys:{api_key}", "requests_count", "0")
        return True
    except Exception:
        return False
