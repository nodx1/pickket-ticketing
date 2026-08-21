"""Bot detection service — server-side challenge/response model.

The signing key (BOT_DETECTION_KEY) NEVER leaves the server.
Clients submit behavior data; the server signs and later verifies tokens.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
import uuid

from app.core.config import settings
from app.core.redis import get_redis

logger = logging.getLogger(__name__)

CHALLENGE_TOKEN_TTL = 300  # 5 minutes
CHALLENGE_RATE_WINDOW = 60  # 1 minute window for rate limiting

# ── Behavior validation helpers ──────────────────────────────────────────────

def _validate_behaviors(behaviors: dict) -> bool:
    """Check that behavior data looks like genuine human interaction."""
    if not isinstance(behaviors, dict):
        return False

    time_on_page = behaviors.get("timeOnPage", 0)
    if not isinstance(time_on_page, (int, float)) or time_on_page <= 0:
        return False

    mouse_moves = behaviors.get("mouseMoves", 0)
    key_presses = behaviors.get("keyPresses", 0)
    scrolls = behaviors.get("scrolls", 0)

    has_any = (
        (isinstance(mouse_moves, (int, float)) and mouse_moves > 0)
        or (isinstance(key_presses, (int, float)) and key_presses > 0)
        or (isinstance(scrolls, (int, float)) and scrolls > 0)
    )
    return has_any


class BotDetectionService:
    # ─── Server-side challenge token issuance ─────────────────────────────

    async def get_challenge_count(self, ip: str) -> int:
        """Count outstanding challenges for this IP in the current window."""
        redis = get_redis()
        key = f"v2:bot:challenge_rate:{ip}"
        count = await redis.get(key)
        return int(count) if count else 0

    async def issue_challenge_token(self, session_id: str, behaviors: dict) -> str:
        """Validate behavior data and return an opaque server-signed token.

        The token is: base64(json({session_id, timestamp, behaviors_hash, hmac}))
        The HMAC is computed SERVER-SIDE with BOT_DETECTION_KEY — never exposed.

        The token is also stored in Redis (one-time use).
        """
        if not _validate_behaviors(behaviors):
            raise ValueError("Invalid behavior data")

        redis = get_redis()
        ip = session_id.split(":")[0]

        # Increment challenge rate counter
        rate_key = f"v2:bot:challenge_rate:{ip}"
        pipe = redis.pipeline(transaction=True)
        pipe.incr(rate_key)
        pipe.expire(rate_key, CHALLENGE_RATE_WINDOW)
        await pipe.execute()

        timestamp = int(time.time())
        behaviors_hash = hashlib.sha256(
            json.dumps(behaviors, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

        # Server-side HMAC — key never leaves the server
        signing_key = settings.BOT_DETECTION_KEY
        hmac_value = hmac.new(
            signing_key.encode(),
            f"{session_id}:{timestamp}:{behaviors_hash}".encode(),
            hashlib.sha256,
        ).hexdigest()

        payload = {
            "sid": session_id,
            "ts": timestamp,
            "bh": behaviors_hash,
            "hmac": hmac_value,
        }
        token = base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()

        # Store token in Redis for one-time use validation
        token_key = f"v2:bot:token:{hmac_value[:16]}"
        await redis.setex(token_key, CHALLENGE_TOKEN_TTL, session_id)

        return token

    # ─── Token verification (server-side only) ────────────────────────────

    async def verify_token(self, token: str, session_id: str) -> bool:
        """Verify a server-issued behavior token.

        Steps:
        1. Decode the token (base64 JSON)
        2. Verify HMAC using server-side key
        3. Verify timestamp within tolerance (5 min)
        4. Verify session_id matches
        5. Consume token in Redis (one-time use)
        """
        try:
            raw = base64.b64decode(token)
            payload = json.loads(raw)
        except Exception:
            logger.debug("Bot token: failed to decode")
            return False

        sid = payload.get("sid")
        ts = payload.get("ts")
        bh = payload.get("bh")
        client_hmac = payload.get("hmac")

        if not all([sid, ts, bh, client_hmac]):
            logger.debug("Bot token: missing fields")
            return False

        # Verify session matches
        if sid != session_id:
            logger.debug("Bot token: session mismatch")
            return False

        # Verify timestamp within tolerance
        now = int(time.time())
        try:
            ts_int = int(ts)
        except (TypeError, ValueError):
            return False
        if abs(now - ts_int) > CHALLENGE_TOKEN_TTL:
            logger.debug("Bot token: expired")
            return False

        # Recompute HMAC server-side
        signing_key = settings.BOT_DETECTION_KEY
        expected = hmac.new(
            signing_key.encode(),
            f"{sid}:{ts}:{bh}".encode(),
            hashlib.sha256,
        ).hexdigest()

        if not hmac.compare_digest(expected, client_hmac):
            logger.debug("Bot token: HMAC mismatch (forged token)")
            return False

        # Consume token (one-time use)
        redis = get_redis()
        token_key = f"v2:bot:token:{client_hmac[:16]}"
        consumed = await redis.delete(token_key)
        if consumed == 0:
            logger.debug("Bot token: already consumed or not found")
            return False

        return True

    # ─── Rate-limiting helpers ────────────────────────────────────────────

    async def _sliding_count(self, key: str, window_seconds: int) -> int:
        redis = get_redis()
        now = time.time()
        cutoff = now - window_seconds
        member = f"{now}:{time.time_ns()}"
        pipe = redis.pipeline(transaction=True)
        pipe.zremrangebyscore(key, "-inf", cutoff)
        pipe.zadd(key, {member: now})
        pipe.zcard(key)
        pipe.expire(key, window_seconds)
        _, _, count, _ = await pipe.execute()
        return int(count)

    async def analyze_behavior(
        self,
        user_id: uuid.UUID | None,
        ip: str,
        behavior_token: str | None,
        user_agent: str | None = None,
    ) -> int:
        score = 0
        normalized_token = (behavior_token or "").strip()
        normalized_ua = (user_agent or "").lower()

        if len(normalized_token) < 32:
            score += 35
        if any(flag in normalized_ua for flag in ("bot", "crawler", "headless", "python", "curl")):
            score += 35
        elif not normalized_ua:
            score += 20

        ip_count = await self._sliding_count(f"v2:bot:ip:{ip}", 60)
        user_count = 0
        if user_id:
            user_count = await self._sliding_count(f"v2:bot:user:{user_id}", 60)

        if ip_count > 30:
            score += 30
        elif ip_count > 15:
            score += 15

        if user_count > 10:
            score += 25
        elif user_count > 5:
            score += 10

        redis = get_redis()
        now = time.time()
        last_seen_key = f"v2:bot:last:{ip}"
        last_seen = await redis.get(last_seen_key)
        await redis.set(last_seen_key, str(now), ex=60)
        if last_seen is not None:
            interval = now - float(last_seen)
            if interval < 0.35:
                score += 20
            elif interval < 0.8:
                score += 10

        return max(0, min(100, score))

    def is_bot(self, score: int, threshold: int = 70) -> bool:
        return score >= threshold

    async def log_detection(
        self,
        user_id: uuid.UUID | None,
        score: int,
        is_blocked: bool,
        ip: str,
        *,
        event_id: uuid.UUID | None = None,
    ) -> None:
        try:
            redis = get_redis()
            payload = {
                "user_id": str(user_id) if user_id else None,
                "score": score,
                "is_blocked": is_blocked,
                "ip_hash": hashlib.sha256(ip.encode("utf-8")).hexdigest(),
                "event_id": str(event_id) if event_id else None,
                "recorded_at": int(time.time()),
            }
            await redis.lpush("v2:bot:detections", json.dumps(payload))
            await redis.ltrim("v2:bot:detections", 0, 499)
            if is_blocked and event_id:
                await redis.incr(f"v2:bot:blocked:event:{event_id}")
                await redis.expire(f"v2:bot:blocked:event:{event_id}", 60 * 60 * 24 * 30)
        except RuntimeError:
            return

    async def enforce_rate_limits(self, ip: str, user_id: uuid.UUID | None) -> tuple[int, int]:
        redis = get_redis()
        ip_count = await self._sliding_count(f"v2:bot:rate:ip:{ip}", 60)
        user_count = 0
        if user_id:
            user_count = await self._sliding_count(f"v2:bot:rate:user:{user_id}", 60)
        return ip_count, user_count
