"""P3-6: Payment fraud detection service.

Multi-signal fraud scoring for payment transactions:
- Card velocity (multiple cards per user, same card multiple users)
- Amount anomalies (sudden high-value purchases)
- Geo-velocity (impossible travel between purchases)
- Device fingerprint anomalies
- Failed payment patterns
"""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.redis import get_redis

logger = logging.getLogger(__name__)


@dataclass
class FraudScore:
    order_id: uuid.UUID
    user_id: uuid.UUID
    total_score: int  # 0-100
    card_velocity_score: int
    amount_anomaly_score: int
    geo_velocity_score: int
    device_score: int
    failure_pattern_score: int
    reasons: list[str] = field(default_factory=list)
    action: str = "allow"  # allow | review | block

    def __post_init__(self):
        if self.total_score >= 80:
            self.action = "block"
        elif self.total_score >= 50:
            self.action = "review"


# ── Thresholds ────────────────────────────────────────────────────────────────

CARD_VELOCITY_WINDOW_HOURS = 24
MAX_CARDS_PER_USER = 3
MAX_USERS_PER_CARD = 2
AMOUNT_STDDEV_THRESHOLD = 3.0  # Standard deviations above mean
GEO_VELOCITY_KMH = 900  # Impossible travel speed (faster than commercial flight)
MAX_FAILURES_BEFORE_SUCCESS = 5

CARD_WEIGHT = 25
AMOUNT_WEIGHT = 20
GEO_WEIGHT = 20
DEVICE_WEIGHT = 15
FAILURE_WEIGHT = 20


async def analyze_payment(
    db: AsyncSession,
    order_id: uuid.UUID,
    user_id: uuid.UUID,
    amount: Decimal,
    card_hash: str | None = None,
    ip: str | None = None,
    device_hash: str | None = None,
) -> FraudScore:
    """Run all fraud checks and return composite score."""
    card_vel = await check_card_velocity(user_id, card_hash) if card_hash else 0
    amount_anom = await check_amount_anomaly(db, user_id, amount)
    geo_vel = await check_geo_velocity(user_id, ip) if ip else 0
    device = await check_device_anomaly(user_id, device_hash) if device_hash else 0
    failures = await check_failure_pattern(user_id)

    # Normalize scores
    card_score = min(100, card_vel * 40)
    amount_score = min(100, int(amount_anom * 33))
    geo_score = 100 if geo_vel else 0
    device_norm = min(100, device * 50)
    failure_score = min(100, int((failures / MAX_FAILURES_BEFORE_SUCCESS) * 100))

    total = int(
        card_score * CARD_WEIGHT / 100
        + amount_score * AMOUNT_WEIGHT / 100
        + geo_score * GEO_WEIGHT / 100
        + device_norm * DEVICE_WEIGHT / 100
        + failure_score * FAILURE_WEIGHT / 100
    )

    reasons = []
    if card_vel > 0:
        reasons.append(f"Card velocity alert: {card_vel} signals")
    if amount_anom >= AMOUNT_STDDEV_THRESHOLD:
        reasons.append(f"Amount {amount_anom:.1f} stddev above user mean")
    if geo_vel:
        reasons.append("Impossible geo-velocity detected")
    if device > 0:
        reasons.append(f"Device anomaly: {device} new devices in window")
    if failures >= MAX_FAILURES_BEFORE_SUCCESS:
        reasons.append(f"High failure rate: {failures} recent failures")

    score = FraudScore(
        order_id=order_id,
        user_id=user_id,
        total_score=min(100, total),
        card_velocity_score=card_score,
        amount_anomaly_score=amount_score,
        geo_velocity_score=geo_score,
        device_score=device_norm,
        failure_pattern_score=failure_score,
        reasons=reasons,
    )

    if score.action != "allow":
        await store_fraud_alert(score)

    return score


async def check_card_velocity(user_id: uuid.UUID, card_hash: str) -> int:
    """Check card usage patterns — multiple cards per user or shared cards."""
    redis = get_redis()
    if redis is None:
        return 0

    try:
        signals = 0

        # Track cards per user
        user_cards_key = f"v2:fraud:user_cards:{user_id}"
        await redis.sadd(user_cards_key, card_hash)
        await redis.expire(user_cards_key, CARD_VELOCITY_WINDOW_HOURS * 3600)
        cards_count = await redis.scard(user_cards_key)
        if cards_count > MAX_CARDS_PER_USER:
            signals += cards_count - MAX_CARDS_PER_USER

        # Track users per card
        card_users_key = f"v2:fraud:card_users:{card_hash}"
        await redis.sadd(card_users_key, str(user_id))
        await redis.expire(card_users_key, CARD_VELOCITY_WINDOW_HOURS * 3600)
        users_count = await redis.scard(card_users_key)
        if users_count > MAX_USERS_PER_CARD:
            signals += users_count - MAX_USERS_PER_CARD

        return signals
    except Exception:
        logger.debug("fraud detection card velocity check failed", exc_info=True)
        return 0


async def check_amount_anomaly(
    db: AsyncSession,
    user_id: uuid.UUID,
    amount: Decimal,
) -> float:
    """Check if amount deviates significantly from user's purchase history."""
    from app.models.order import Order, OrderStatus

    try:
        result = await db.execute(
            select(
                func.avg(Order.total_amount).label("avg_amount"),
                func.stddev(Order.total_amount).label("stddev_amount"),
            ).where(
                and_(
                    Order.user_id == user_id,
                    Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID, OrderStatus.REFUNDED]),
                )
            )
        )
        row = result.first()
    except Exception:
        return 0.0

    if not row or not row.avg_amount or not row.stddev_amount:
        # No history — flag large first purchases
        if amount > Decimal("500000"):  # 50만원
            return 2.0
        return 0.0

    avg = float(row.avg_amount)
    stddev = float(row.stddev_amount) or 1.0
    deviation = (float(amount) - avg) / stddev

    return max(0.0, deviation)


async def check_geo_velocity(user_id: uuid.UUID, ip: str) -> bool:
    """Check for impossible travel speed between recent purchases."""
    redis = get_redis()
    if redis is None:
        return False

    try:
        key = f"v2:fraud:geo:{user_id}"
        last = await redis.hgetall(key)

        # Store current
        now = datetime.now(timezone.utc).isoformat()
        await redis.hset(key, mapping={"ip": ip, "ts": now})
        await redis.expire(key, 3600)

        if not last:
            return False

        last_ip = (last.get(b"ip") or last.get("ip", b"")).decode() if last else ""

        # Simple check: different IP in very short time
        # Full implementation would use GeoIP lookup
        if last_ip and last_ip != ip:
            last_ts_raw = (last.get(b"ts") or last.get("ts", b"")).decode()
            if last_ts_raw:
                last_time = datetime.fromisoformat(last_ts_raw)
                elapsed = (datetime.now(timezone.utc) - last_time).total_seconds()
                # If different IP within 5 minutes, flag as suspicious
                if elapsed < 300:
                    return True

        return False
    except Exception:
        logger.debug("fraud detection geo velocity check failed", exc_info=True)
        return False


async def check_device_anomaly(user_id: uuid.UUID, device_hash: str) -> int:
    """Count new devices in recent window."""
    redis = get_redis()
    if redis is None:
        return 0

    try:
        key = f"v2:fraud:devices:{user_id}"
        await redis.sadd(key, device_hash)
        await redis.expire(key, 86400)
        count = await redis.scard(key)
        # More than 2 devices in 24h is suspicious
        return max(0, (count or 0) - 2)
    except Exception:
        logger.debug("fraud detection device anomaly check failed", exc_info=True)
        return 0


async def check_failure_pattern(user_id: uuid.UUID) -> int:
    """Count recent payment failures (card testing pattern)."""
    redis = get_redis()
    if redis is None:
        return 0

    try:
        key = f"v2:fraud:failures:{user_id}"
        count = await redis.get(key)
        return int(count) if count else 0
    except Exception:
        logger.debug("fraud detection failure pattern check failed", exc_info=True)
        return 0


async def record_payment_failure(user_id: uuid.UUID) -> None:
    """Increment payment failure counter."""
    redis = get_redis()
    if redis is None:
        return

    try:
        key = f"v2:fraud:failures:{user_id}"
        await redis.incr(key)
        await redis.expire(key, 3600)  # 1 hour window
    except Exception:
        logger.debug("fraud detection record payment failure failed", exc_info=True)


async def record_payment_success(user_id: uuid.UUID) -> None:
    """Reset failure counter on success."""
    redis = get_redis()
    if redis is None:
        return

    try:
        key = f"v2:fraud:failures:{user_id}"
        await redis.delete(key)
    except Exception:
        logger.debug("fraud detection reset payment success failed", exc_info=True)


async def store_fraud_alert(score: FraudScore) -> None:
    """Store fraud alert in Redis for admin review."""
    redis = get_redis()
    if redis is None:
        return

    try:
        key = f"v2:fraud:alert:{score.order_id}"
        await redis.hset(key, mapping={
            "order_id": str(score.order_id),
            "user_id": str(score.user_id),
            "score": str(score.total_score),
            "action": score.action,
            "reasons": "; ".join(score.reasons),
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        await redis.expire(key, 86400 * 30)  # Keep 30 days

        # Add to sorted set for admin dashboard
        await redis.zadd(
            "v2:fraud:alerts",
            {str(score.order_id): score.total_score},
        )
    except Exception:
        logger.debug("fraud detection store alert failed", exc_info=True)


async def get_fraud_alerts(limit: int = 50, min_score: int = 50) -> list[dict]:
    """Get recent fraud alerts for admin review."""
    redis = get_redis()
    if redis is None:
        return []

    try:
        alerts = await redis.zrevrangebyscore(
            "v2:fraud:alerts",
            max=100,
            min=min_score,
            start=0,
            num=limit,
            withscores=True,
        )
        results = []
        for order_id_bytes, score in alerts:
            oid = order_id_bytes.decode() if isinstance(order_id_bytes, bytes) else order_id_bytes
            details = await redis.hgetall(f"v2:fraud:alert:{oid}")
            if details:
                result = {}
                for k, v in details.items():
                    key = k.decode() if isinstance(k, bytes) else k
                    val = v.decode() if isinstance(v, bytes) else v
                    result[key] = val
                result["score"] = int(score)
                results.append(result)
        return results
    except Exception:
        logger.debug("fraud detection get alerts failed", exc_info=True)
        return []
