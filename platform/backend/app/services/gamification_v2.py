"""P3-10: Gamification V2 — Streaks, leaderboards, and challenges.

Extends the existing quest/badge system with:
- Login streaks and attendance tracking
- Event participation leaderboards
- Time-limited challenges
- Achievement milestones with rewards (AP/badges)
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum

from sqlalchemy import select, func, and_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.redis import get_redis


class ChallengeType(str, Enum):
    ATTEND_EVENTS = "attend_events"
    WRITE_REVIEWS = "write_reviews"
    SHARE_PHOTOS = "share_photos"
    REFER_FRIENDS = "refer_friends"
    PURCHASE_STREAK = "purchase_streak"
    COMMUNITY_ENGAGE = "community_engage"


@dataclass
class StreakInfo:
    user_id: uuid.UUID
    current_streak: int
    longest_streak: int
    last_activity_date: str
    next_milestone: int
    milestone_reward_ap: int


@dataclass
class LeaderboardEntry:
    rank: int
    user_id: str
    display_name: str
    score: int
    badge: str | None = None


@dataclass
class Challenge:
    id: str
    type: ChallengeType
    title: str
    description: str
    target: int
    reward_ap: int
    reward_badge: str | None
    starts_at: str
    ends_at: str
    progress: int = 0
    completed: bool = False


# ── Streak Milestones ─────────────────────────────────────────────────────────

STREAK_MILESTONES = {
    3: 50,    # 3일 연속 → 50 AP
    7: 150,   # 7일 연속 → 150 AP
    14: 400,  # 14일 연속 → 400 AP
    30: 1000, # 30일 연속 → 1000 AP
    60: 2500, # 60일 연속 → 2500 AP
    100: 5000,  # 100일 연속 → 5000 AP
}


# ── Streak System ─────────────────────────────────────────────────────────────

async def record_daily_activity(user_id: uuid.UUID) -> StreakInfo:
    """Record daily login/activity and update streak."""
    redis = get_redis()
    if redis is None:
        return StreakInfo(
            user_id=user_id, current_streak=0, longest_streak=0,
            last_activity_date="", next_milestone=3, milestone_reward_ap=50,
        )

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    key = f"v2:gamify:streak:{user_id}"

    try:
        data = await redis.hgetall(key)
        current_streak = int(_decode(data, "current", "0"))
        longest_streak = int(_decode(data, "longest", "0"))
        last_date = _decode(data, "last_date", "")

        if last_date == today:
            # Already recorded today
            pass
        elif last_date == yesterday:
            current_streak += 1
        else:
            current_streak = 1

        longest_streak = max(longest_streak, current_streak)

        await redis.hset(key, mapping={
            "current": str(current_streak),
            "longest": str(longest_streak),
            "last_date": today,
        })
        # No expiry — streaks are persistent

        # Find next milestone
        next_ms = 3
        ms_reward = 50
        for milestone, reward in sorted(STREAK_MILESTONES.items()):
            if current_streak < milestone:
                next_ms = milestone
                ms_reward = reward
                break

        # Check if milestone just reached
        if current_streak in STREAK_MILESTONES and last_date != today:
            reward = STREAK_MILESTONES[current_streak]
            await _grant_ap_reward(user_id, reward, f"streak_{current_streak}")

        return StreakInfo(
            user_id=user_id,
            current_streak=current_streak,
            longest_streak=longest_streak,
            last_activity_date=today,
            next_milestone=next_ms,
            milestone_reward_ap=ms_reward,
        )
    except Exception:
        return StreakInfo(
            user_id=user_id, current_streak=0, longest_streak=0,
            last_activity_date="", next_milestone=3, milestone_reward_ap=50,
        )


async def get_streak(user_id: uuid.UUID) -> StreakInfo:
    """Get current streak info without recording activity."""
    redis = get_redis()
    if redis is None:
        return StreakInfo(
            user_id=user_id, current_streak=0, longest_streak=0,
            last_activity_date="", next_milestone=3, milestone_reward_ap=50,
        )

    try:
        key = f"v2:gamify:streak:{user_id}"
        data = await redis.hgetall(key)
        current = int(_decode(data, "current", "0"))
        longest = int(_decode(data, "longest", "0"))
        last_date = _decode(data, "last_date", "")

        next_ms = 3
        ms_reward = 50
        for milestone, reward in sorted(STREAK_MILESTONES.items()):
            if current < milestone:
                next_ms = milestone
                ms_reward = reward
                break

        return StreakInfo(
            user_id=user_id,
            current_streak=current,
            longest_streak=longest,
            last_activity_date=last_date,
            next_milestone=next_ms,
            milestone_reward_ap=ms_reward,
        )
    except Exception:
        return StreakInfo(
            user_id=user_id, current_streak=0, longest_streak=0,
            last_activity_date="", next_milestone=3, milestone_reward_ap=50,
        )


# ── Leaderboard ───────────────────────────────────────────────────────────────

LEADERBOARD_TYPES = {
    "events_attended": "이벤트 참석 랭킹",
    "ap_earned": "AP 획득 랭킹",
    "reviews_written": "리뷰 랭킹",
    "streak_longest": "최장 연속 출석 랭킹",
}


async def update_leaderboard(
    user_id: uuid.UUID,
    board_type: str,
    score: int,
    display_name: str = "",
) -> None:
    """Update a user's leaderboard score."""
    redis = get_redis()
    if redis is None:
        return

    try:
        key = f"v2:gamify:lb:{board_type}"
        await redis.zadd(key, {str(user_id): score})

        if display_name:
            name_key = f"v2:gamify:lb_names:{board_type}"
            await redis.hset(name_key, str(user_id), display_name)
    except Exception:
        pass


async def get_leaderboard(
    board_type: str,
    limit: int = 20,
    offset: int = 0,
) -> list[LeaderboardEntry]:
    """Get top entries from a leaderboard."""
    redis = get_redis()
    if redis is None:
        return []

    try:
        key = f"v2:gamify:lb:{board_type}"
        name_key = f"v2:gamify:lb_names:{board_type}"

        entries = await redis.zrevrange(
            key, offset, offset + limit - 1, withscores=True,
        )

        results = []
        for rank_offset, (uid_bytes, score) in enumerate(entries):
            uid = uid_bytes.decode() if isinstance(uid_bytes, bytes) else uid_bytes
            name_bytes = await redis.hget(name_key, uid)
            name = name_bytes.decode() if name_bytes and isinstance(name_bytes, bytes) else (name_bytes or uid[:8])

            results.append(LeaderboardEntry(
                rank=offset + rank_offset + 1,
                user_id=uid,
                display_name=name,
                score=int(score),
            ))

        return results
    except Exception:
        return []


async def get_user_rank(
    user_id: uuid.UUID,
    board_type: str,
) -> int | None:
    """Get a user's rank on a leaderboard (1-indexed)."""
    redis = get_redis()
    if redis is None:
        return None

    try:
        key = f"v2:gamify:lb:{board_type}"
        rank = await redis.zrevrank(key, str(user_id))
        return (rank + 1) if rank is not None else None
    except Exception:
        return None


# ── Challenges ────────────────────────────────────────────────────────────────

DEFAULT_CHALLENGES = [
    Challenge(
        id="weekly_3events",
        type=ChallengeType.ATTEND_EVENTS,
        title="이번 주 이벤트 3회 참석",
        description="이번 주에 3개 이상의 이벤트에 참석하세요",
        target=3,
        reward_ap=300,
        reward_badge="event_explorer",
        starts_at="",
        ends_at="",
    ),
    Challenge(
        id="review_master",
        type=ChallengeType.WRITE_REVIEWS,
        title="리뷰 5개 작성",
        description="이벤트 리뷰를 5개 이상 작성하세요",
        target=5,
        reward_ap=200,
        reward_badge="review_master",
        starts_at="",
        ends_at="",
    ),
    Challenge(
        id="photo_share",
        type=ChallengeType.SHARE_PHOTOS,
        title="사진 10장 공유",
        description="이벤트 사진을 10장 공유하세요",
        target=10,
        reward_ap=150,
        reward_badge=None,
        starts_at="",
        ends_at="",
    ),
]


async def get_active_challenges(user_id: uuid.UUID) -> list[Challenge]:
    """Get active challenges with user progress."""
    redis = get_redis()
    if redis is None:
        return DEFAULT_CHALLENGES

    now = datetime.now(timezone.utc)
    # Weekly challenges reset on Monday
    week_start = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
    week_end = (now + timedelta(days=6 - now.weekday())).strftime("%Y-%m-%d")

    challenges = []
    for template in DEFAULT_CHALLENGES:
        challenge = Challenge(
            id=template.id,
            type=template.type,
            title=template.title,
            description=template.description,
            target=template.target,
            reward_ap=template.reward_ap,
            reward_badge=template.reward_badge,
            starts_at=week_start,
            ends_at=week_end,
        )

        try:
            progress_key = f"v2:gamify:challenge:{user_id}:{template.id}:{week_start}"
            progress = await redis.get(progress_key)
            challenge.progress = int(progress) if progress else 0
            challenge.completed = challenge.progress >= challenge.target
        except Exception:
            pass

        challenges.append(challenge)

    return challenges


async def increment_challenge_progress(
    user_id: uuid.UUID,
    challenge_type: ChallengeType,
    amount: int = 1,
) -> None:
    """Increment progress for challenges matching the type."""
    redis = get_redis()
    if redis is None:
        return

    now = datetime.now(timezone.utc)
    week_start = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")

    for template in DEFAULT_CHALLENGES:
        if template.type != challenge_type:
            continue

        try:
            progress_key = f"v2:gamify:challenge:{user_id}:{template.id}:{week_start}"
            new_val = await redis.incrby(progress_key, amount)
            await redis.expire(progress_key, 86400 * 8)  # Expire after week + 1 day

            # Check completion
            if new_val >= template.target:
                completed_key = f"v2:gamify:challenge_done:{user_id}:{template.id}:{week_start}"
                already_done = await redis.get(completed_key)
                if not already_done:
                    await redis.set(completed_key, "1", ex=86400 * 8)
                    await _grant_ap_reward(user_id, template.reward_ap, f"challenge_{template.id}")
        except Exception:
            pass


# ── Helpers ───────────────────────────────────────────────────────────────────

def _decode(data: dict, key: str, default: str = "") -> str:
    """Decode Redis hash value (bytes or str)."""
    val = data.get(key.encode(), data.get(key, default))
    if isinstance(val, bytes):
        return val.decode()
    return str(val) if val else default


async def _grant_ap_reward(user_id: uuid.UUID, amount: int, source: str) -> None:
    """Grant AP reward (adds to Redis counter, actual DB update via Celery)."""
    redis = get_redis()
    if redis is None:
        return

    try:
        # Queue reward for async processing
        reward_key = f"v2:gamify:rewards:{user_id}"
        await redis.hincrby(reward_key, "pending_ap", amount)
        await redis.expire(reward_key, 86400 * 7)

        # Log reward
        import json
        log_entry = json.dumps({
            "source": source,
            "amount": amount,
            "ts": datetime.now(timezone.utc).isoformat(),
        })
        await redis.lpush(f"v2:gamify:reward_log:{user_id}", log_entry)
        await redis.ltrim(f"v2:gamify:reward_log:{user_id}", 0, 99)
    except Exception:
        pass
