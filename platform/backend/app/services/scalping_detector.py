"""P3-5: Scalping pattern detection service.

Analyzes user behavior to detect potential ticket scalping:
- Purchase velocity anomalies
- Bulk buying patterns
- Buy-then-resale patterns
- IP clustering (multiple accounts, same IP)
"""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.redis import get_redis

logger = logging.getLogger(__name__)


@dataclass
class ScalpingScore:
    user_id: uuid.UUID
    total_score: int  # 0-100
    velocity_score: int
    bulk_score: int
    resale_score: int
    ip_cluster_score: int
    reasons: list[str] = field(default_factory=list)
    flagged: bool = False

    def __post_init__(self):
        self.flagged = self.total_score >= 70


# -- Thresholds ----------------------------------------------------------------

VELOCITY_THRESHOLD = 5       # purchases in 30 min window
BULK_AMOUNT_THRESHOLD = 10   # tickets in 24h
RESALE_WINDOW_HOURS = 48     # buy-then-list within this window
IP_CLUSTER_THRESHOLD = 3     # accounts per IP in 24h

VELOCITY_WEIGHT = 30
BULK_WEIGHT = 25
RESALE_WEIGHT = 30
IP_CLUSTER_WEIGHT = 15


async def analyze_user(
    db: AsyncSession,
    user_id: uuid.UUID,
    window_minutes: int = 60,
) -> ScalpingScore:
    """Run all scalping checks and return composite score."""
    # 정상 유저(score < 70) 캐시 — 구매마다 DB 4회 절감
    redis = get_redis()
    if redis is not None:
        try:
            cache_key = f"v2:scalp:score:{user_id}"
            cached = await redis.get(cache_key)
            if cached is not None and int(cached) < 70:
                return ScalpingScore(
                    user_id=user_id,
                    total_score=int(cached),
                    velocity_score=0,
                    bulk_score=0,
                    resale_score=0,
                    ip_cluster_score=0,
                )
        except Exception:
            logger.debug("scalping detection cache read failed", exc_info=True)

    velocity = await check_purchase_velocity(db, user_id, window_minutes)
    bulk = await check_bulk_buying(db, user_id)
    resale = await check_resale_pattern(db, user_id)
    ip_cluster = await check_ip_clustering(user_id)

    # Normalize to 0-100 per signal
    velocity_score = min(100, int((velocity / VELOCITY_THRESHOLD) * 100)) if velocity > 0 else 0
    bulk_score = min(100, int((bulk / BULK_AMOUNT_THRESHOLD) * 100)) if bulk > 0 else 0
    resale_score = 100 if resale else 0
    ip_score = min(100, int((ip_cluster / IP_CLUSTER_THRESHOLD) * 100)) if ip_cluster > 0 else 0

    # Weighted total
    total = int(
        velocity_score * VELOCITY_WEIGHT / 100
        + bulk_score * BULK_WEIGHT / 100
        + resale_score * RESALE_WEIGHT / 100
        + ip_score * IP_CLUSTER_WEIGHT / 100
    )

    reasons = []
    if velocity >= VELOCITY_THRESHOLD:
        reasons.append(f"High purchase velocity: {velocity} in {window_minutes}min")
    if bulk >= BULK_AMOUNT_THRESHOLD:
        reasons.append(f"Bulk buying: {bulk} tickets in 24h")
    if resale:
        reasons.append(f"Buy-then-resale pattern within {RESALE_WINDOW_HOURS}h")
    if ip_cluster >= IP_CLUSTER_THRESHOLD:
        reasons.append(f"IP clustering: {ip_cluster} accounts share IP")

    score = ScalpingScore(
        user_id=user_id,
        total_score=min(100, total),
        velocity_score=velocity_score,
        bulk_score=bulk_score,
        resale_score=resale_score,
        ip_cluster_score=ip_score,
        reasons=reasons,
    )

    if score.flagged:
        await flag_user(user_id, score.total_score, "; ".join(reasons))

    # 30초 캐시 — 정상 유저 재구매 시 DB 스킵
    if redis is not None:
        try:
            await redis.setex(f"v2:scalp:score:{user_id}", 30, str(score.total_score))
        except Exception:
            logger.debug("scalping detection cache write failed", exc_info=True)

    return score


async def check_purchase_velocity(
    db: AsyncSession,
    user_id: uuid.UUID,
    window_minutes: int = 30,
) -> int:
    """Count purchases within sliding window."""
    from app.models.user_behavior import UserBehavior

    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=window_minutes)
    result = await db.execute(
        select(func.count())
        .where(
            and_(
                UserBehavior.user_id == user_id,
                UserBehavior.event_type == "purchase",
                UserBehavior.created_at >= cutoff,
            )
        )
    )
    return result.scalar() or 0


async def check_bulk_buying(
    db: AsyncSession,
    user_id: uuid.UUID,
) -> int:
    """Count total ticket purchases in last 24h."""
    from app.models.user_behavior import UserBehavior

    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=24)
    result = await db.execute(
        select(func.count())
        .where(
            and_(
                UserBehavior.user_id == user_id,
                UserBehavior.event_type.in_(["purchase", "bid"]),
                UserBehavior.created_at >= cutoff,
            )
        )
    )
    return result.scalar() or 0


async def check_resale_pattern(
    db: AsyncSession,
    user_id: uuid.UUID,
) -> bool:
    """Detect buy-then-immediately-list-for-resale pattern."""
    from app.models.user_behavior import UserBehavior

    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=RESALE_WINDOW_HOURS)

    # Get recent purchases
    purchases = await db.execute(
        select(UserBehavior.target_id, UserBehavior.created_at)
        .where(
            and_(
                UserBehavior.user_id == user_id,
                UserBehavior.event_type == "purchase",
                UserBehavior.target_type == "ticket",
                UserBehavior.created_at >= cutoff,
            )
        )
    )
    purchased_tickets = {row.target_id: row.created_at for row in purchases.all()}

    if not purchased_tickets:
        return False

    # Check if any purchased ticket was listed for resale
    resale_listings = await db.execute(
        select(UserBehavior.target_id)
        .where(
            and_(
                UserBehavior.user_id == user_id,
                UserBehavior.event_type == "resale_list",
                UserBehavior.target_type == "ticket",
                UserBehavior.target_id.in_(list(purchased_tickets.keys())),
                UserBehavior.created_at >= cutoff,
            )
        )
    )

    return len(resale_listings.all()) > 0


async def check_ip_clustering(user_id: uuid.UUID) -> int:
    """Check how many distinct users share the same IP in recent activity."""
    redis = get_redis()
    if redis is None:
        return 0

    try:
        # Look up recent IPs for this user
        ip_key = f"v2:scalp:user_ips:{user_id}"
        ips = await redis.smembers(ip_key)

        if not ips:
            return 0

        max_cluster = 0
        for ip in ips:
            ip_str = ip.decode() if isinstance(ip, bytes) else ip
            cluster_key = f"v2:scalp:ip_users:{ip_str}"
            count = await redis.scard(cluster_key)
            max_cluster = max(max_cluster, count or 0)

        return max_cluster
    except Exception:
        logger.debug("scalping detection ip clustering check failed", exc_info=True)
        return 0


async def flag_user(user_id: uuid.UUID, score: int, reason: str) -> None:
    """Store scalping flag in Redis for admin review."""
    redis = get_redis()
    if redis is None:
        return

    try:
        key = f"v2:scalp:flagged:{user_id}"
        await redis.hset(key, mapping={
            "score": str(score),
            "reason": reason,
            "flagged_at": datetime.now(timezone.utc).isoformat(),
        })
        await redis.expire(key, 86400 * 7)  # Keep for 7 days

        # Add to flagged users set
        await redis.zadd(
            "v2:scalp:flagged_users",
            {str(user_id): score},
        )
    except Exception:
        logger.debug("scalping detection flag user failed", exc_info=True)


async def record_ip(user_id: uuid.UUID, ip: str) -> None:
    """Record user<->IP association for clustering detection."""
    redis = get_redis()
    if redis is None:
        return

    try:
        user_ip_key = f"v2:scalp:user_ips:{user_id}"
        ip_user_key = f"v2:scalp:ip_users:{ip}"

        pipe = redis.pipeline()
        pipe.sadd(user_ip_key, ip)
        pipe.expire(user_ip_key, 86400)
        pipe.sadd(ip_user_key, str(user_id))
        pipe.expire(ip_user_key, 86400)
        await pipe.execute()
    except Exception:
        logger.debug("scalping detection record ip failed", exc_info=True)


async def get_flagged_users(limit: int = 50) -> list[dict]:
    """Get top flagged users for admin review."""
    redis = get_redis()
    if redis is None:
        return []

    try:
        flagged = await redis.zrevrange("v2:scalp:flagged_users", 0, limit - 1, withscores=True)
        results = []
        for user_id_bytes, score in flagged:
            uid = user_id_bytes.decode() if isinstance(user_id_bytes, bytes) else user_id_bytes
            details_key = f"v2:scalp:flagged:{uid}"
            details = await redis.hgetall(details_key)
            reason = (details.get(b"reason") or details.get("reason", b"")).decode() if details else ""
            flagged_at = (details.get(b"flagged_at") or details.get("flagged_at", b"")).decode() if details else ""
            results.append({
                "user_id": uid,
                "score": int(score),
                "reason": reason,
                "flagged_at": flagged_at,
            })
        return results
    except Exception:
        logger.debug("scalping detection get flagged users failed", exc_info=True)
        return []
