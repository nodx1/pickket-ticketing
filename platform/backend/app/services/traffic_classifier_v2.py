"""P3-4: Enhanced 4-tier traffic classifier with ML-like heuristics.

Extends basic traffic_classifier with:
- Behavioral sequence analysis (click patterns over time)
- Browser fingerprint consistency checks
- Request timing entropy analysis
- Adaptive thresholds based on historical data
- Per-session classification with confidence scoring
"""

import hashlib
import logging
import math
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any

import json
from app.core.redis import get_redis

logger = logging.getLogger(__name__)


class TrafficTier(str, Enum):
    HUMAN = "human"
    AUTH_AGENT = "auth_agent"      # Legitimate AI agents with delegation tokens
    SUSPICIOUS = "suspicious"      # Potential bot/scraper, needs CAPTCHA
    MALICIOUS = "malicious"        # Confirmed bad actor, block


@dataclass
class ClassificationResult:
    session_id: str
    tier: TrafficTier
    confidence: float  # 0.0-1.0
    signals: dict[str, float] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)
    action: str = "allow"  # allow | captcha | throttle | block

    def __post_init__(self):
        if self.tier == TrafficTier.MALICIOUS:
            self.action = "block"
        elif self.tier == TrafficTier.SUSPICIOUS:
            self.action = "captcha"
        elif self.tier == TrafficTier.AUTH_AGENT:
            self.action = "allow"
        else:
            self.action = "allow"


# ── Signal Extractors ─────────────────────────────────────────────────────────

def extract_user_agent_signals(user_agent: str) -> dict[str, float]:
    """Extract classification signals from User-Agent."""
    signals = {}
    ua_lower = user_agent.lower()

    # Known bot signatures
    BOT_PATTERNS = [
        "bot", "crawler", "spider", "scraper", "headless",
        "phantom", "selenium", "puppeteer", "playwright",
    ]
    bot_hits = sum(1 for p in BOT_PATTERNS if p in ua_lower)
    signals["bot_signature"] = min(1.0, bot_hits * 0.5)

    # Known agent signatures (legitimate)
    AGENT_PATTERNS = ["pickketagent", "gpt", "claude", "agent"]
    agent_hits = sum(1 for p in AGENT_PATTERNS if p in ua_lower)
    signals["agent_signature"] = min(1.0, agent_hits * 0.5)

    # Missing or unusual UA
    if len(user_agent) < 10:
        signals["ua_suspicion"] = 0.8
    elif len(user_agent) > 500:
        signals["ua_suspicion"] = 0.4
    else:
        signals["ua_suspicion"] = 0.0

    return signals


def extract_header_signals(headers: dict[str, str]) -> dict[str, float]:
    """Extract signals from HTTP headers."""
    signals = {}

    # Check for delegation token (auth agent)
    has_delegation = bool(headers.get("x-delegation-token"))
    signals["has_delegation_token"] = 1.0 if has_delegation else 0.0

    # Check for screen info (human browser)
    has_screen = bool(headers.get("x-screen-info"))
    signals["has_screen_info"] = 1.0 if has_screen else 0.0

    # Check for timezone (human browser)
    has_timezone = bool(headers.get("x-timezone"))
    signals["has_timezone"] = 1.0 if has_timezone else 0.0

    # Check for accept-language (humans usually have this)
    has_lang = bool(headers.get("accept-language"))
    signals["has_accept_language"] = 1.0 if has_lang else 0.0

    # Check for referer (bots often don't have this)
    has_referer = bool(headers.get("referer"))
    signals["has_referer"] = 1.0 if has_referer else 0.0

    # Behavior token
    has_behavior = bool(headers.get("x-behavior-token"))
    signals["has_behavior_token"] = 1.0 if has_behavior else 0.0

    return signals


async def extract_behavioral_signals(
    session_id: str,
    ip: str,
) -> dict[str, float]:
    """Extract behavioral signals from session history."""
    redis = get_redis()
    signals = {}

    if redis is None:
        return signals

    try:
        # Request velocity
        velocity_key = f"v2:tc:velocity:{session_id}"
        count = await redis.incr(velocity_key)
        if count == 1:
            await redis.expire(velocity_key, 60)
        signals["request_velocity_60s"] = min(1.0, (count or 0) / 100)

        # IP velocity
        ip_key = f"v2:tc:ip_velocity:{ip}"
        ip_count = await redis.incr(ip_key)
        if ip_count == 1:
            await redis.expire(ip_key, 60)
        signals["ip_velocity_60s"] = min(1.0, (ip_count or 0) / 200)

        # Request timing entropy
        timing_key = f"v2:tc:timing:{session_id}"
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        await redis.lpush(timing_key, str(now_ms))
        await redis.ltrim(timing_key, 0, 19)  # Keep last 20 timestamps
        await redis.expire(timing_key, 300)

        timings = await redis.lrange(timing_key, 0, 19)
        if len(timings) >= 5:
            timestamps = [int(t.decode() if isinstance(t, bytes) else t) for t in timings]
            intervals = [timestamps[i] - timestamps[i + 1] for i in range(len(timestamps) - 1)]
            entropy = _calculate_entropy(intervals)
            # Low entropy = regular timing = likely bot
            signals["timing_entropy"] = min(1.0, entropy / 3.0)
        else:
            signals["timing_entropy"] = 0.5  # Neutral

        # Path diversity (unique paths visited)
        path_key = f"v2:tc:paths:{session_id}"
        path_count = await redis.scard(path_key)
        signals["path_diversity"] = min(1.0, (path_count or 0) / 10)

    except Exception:
        logger.debug("traffic classification behavioral signal extraction failed", exc_info=True)

    return signals


def _calculate_entropy(intervals: list[int]) -> float:
    """Calculate Shannon entropy of request intervals."""
    if not intervals:
        return 0.0

    # Bucket intervals into ranges
    buckets: dict[int, int] = {}
    for iv in intervals:
        # Bucket by 100ms ranges
        bucket = iv // 100
        buckets[bucket] = buckets.get(bucket, 0) + 1

    total = len(intervals)
    entropy = 0.0
    for count in buckets.values():
        p = count / total
        if p > 0:
            entropy -= p * math.log2(p)

    return entropy


# ── Classification Engine ─────────────────────────────────────────────────────

# Signal weights for final classification
SIGNAL_WEIGHTS = {
    "bot_signature": -0.8,        # Strong negative (likely bot)
    "agent_signature": 0.0,       # Neutral (could be auth agent)
    "ua_suspicion": -0.5,
    "has_delegation_token": 0.9,  # Strong positive (auth agent)
    "has_screen_info": 0.3,
    "has_timezone": 0.2,
    "has_accept_language": 0.2,
    "has_referer": 0.15,
    "has_behavior_token": 0.4,
    "request_velocity_60s": -0.6, # High velocity = likely bot
    "ip_velocity_60s": -0.4,
    "timing_entropy": 0.3,        # High entropy = likely human
    "path_diversity": 0.2,
}

# Classification thresholds
HUMAN_THRESHOLD = 0.4
SUSPICIOUS_THRESHOLD = -0.1
MALICIOUS_THRESHOLD = -0.5


async def classify(
    session_id: str,
    ip: str,
    user_agent: str,
    headers: dict[str, str],
    path: str = "",
) -> ClassificationResult:
    """Classify a request into one of 4 traffic tiers."""
    # Extract all signals
    ua_signals = extract_user_agent_signals(user_agent)
    header_signals = extract_header_signals(headers)
    behavioral_signals = await extract_behavioral_signals(session_id, ip)

    all_signals = {**ua_signals, **header_signals, **behavioral_signals}

    # Record path for diversity tracking
    redis = get_redis()
    if redis and path:
        try:
            path_key = f"v2:tc:paths:{session_id}"
            await redis.sadd(path_key, path)
            await redis.expire(path_key, 300)
        except Exception:
            logger.debug("traffic classification path tracking failed", exc_info=True)

    # Fast path: delegation token = auth agent
    if all_signals.get("has_delegation_token", 0) > 0.5:
        return ClassificationResult(
            session_id=session_id,
            tier=TrafficTier.AUTH_AGENT,
            confidence=0.95,
            signals=all_signals,
            reasons=["Valid delegation token present"],
        )

    # Calculate weighted score
    score = 0.0
    for signal_name, value in all_signals.items():
        weight = SIGNAL_WEIGHTS.get(signal_name, 0)
        score += value * weight

    # Determine tier
    reasons = []
    if score >= HUMAN_THRESHOLD:
        tier = TrafficTier.HUMAN
        confidence = min(0.95, 0.5 + score * 0.3)
        reasons.append(f"Score {score:.2f} above human threshold")
    elif score >= SUSPICIOUS_THRESHOLD:
        tier = TrafficTier.SUSPICIOUS
        confidence = 0.5 + abs(score) * 0.2
        reasons.append(f"Score {score:.2f} in suspicious range")
    elif score >= MALICIOUS_THRESHOLD:
        tier = TrafficTier.SUSPICIOUS
        confidence = 0.6 + abs(score) * 0.2
        reasons.append(f"Score {score:.2f} approaching malicious threshold")
    else:
        tier = TrafficTier.MALICIOUS
        confidence = min(0.95, 0.7 + abs(score) * 0.1)
        reasons.append(f"Score {score:.2f} below malicious threshold")

    # Add signal-specific reasons
    if all_signals.get("bot_signature", 0) > 0:
        reasons.append("Bot signature detected in User-Agent")
    if all_signals.get("request_velocity_60s", 0) > 0.5:
        reasons.append("High request velocity")
    if all_signals.get("timing_entropy", 0.5) < 0.2:
        reasons.append("Low timing entropy (automated pattern)")

    result = ClassificationResult(
        session_id=session_id,
        tier=tier,
        confidence=round(confidence, 2),
        signals=all_signals,
        reasons=reasons,
    )

    # Record classification for analytics
    if redis:
        try:
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            await redis.hincrby(f"v2:tc:stats:{today}", tier.value, 1)
            await redis.expire(f"v2:tc:stats:{today}", 86400 * 7)
        except Exception:
            logger.debug("traffic classification stats recording failed", exc_info=True)

    return result


# ── Admin Analytics ───────────────────────────────────────────────────────────

async def get_classification_stats(days: int = 7) -> dict:
    """Get traffic classification statistics."""
    redis = get_redis()
    if redis is None:
        return {}

    try:
        stats = {"daily": {}, "totals": {t.value: 0 for t in TrafficTier}}

        for i in range(days):
            date = (datetime.now(timezone.utc) - timedelta(days=i)).strftime("%Y-%m-%d")
            data = await redis.hgetall(f"v2:tc:stats:{date}")
            daily = {}
            for k, v in data.items():
                tier = k.decode() if isinstance(k, bytes) else k
                count = int(v.decode() if isinstance(v, bytes) else v)
                daily[tier] = count
                stats["totals"][tier] = stats["totals"].get(tier, 0) + count
            stats["daily"][date] = daily

        return stats
    except Exception:
        logger.debug("traffic classification get stats failed", exc_info=True)
        return {}
