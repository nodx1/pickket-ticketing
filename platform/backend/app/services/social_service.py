"""P3-11: Enhanced social features.

Social graph and activity feed:
- Friend connections (follow is already implemented, this adds mutual friends)
- Activity feed (purchases, reviews, photos shared by connections)
- Group event planning (invite friends to events)
- Social proof signals (X friends attending, trending with your network)
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, func, and_, exists
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.redis import get_redis


@dataclass
class FriendSuggestion:
    user_id: str
    display_name: str
    mutual_count: int
    reason: str  # "mutual_friends" | "same_events" | "same_community"


@dataclass
class ActivityFeedItem:
    id: str
    actor_id: str
    actor_name: str
    action: str  # "purchased" | "reviewed" | "shared_photo" | "attending"
    target_type: str  # "event" | "ticket" | "review"
    target_id: str
    target_title: str
    created_at: str
    metadata: dict = field(default_factory=dict)


@dataclass
class SocialProof:
    event_id: str
    friends_attending: int
    friend_names: list[str]
    network_interest: int  # total network interactions
    trending_in_network: bool


# ── Activity Feed ─────────────────────────────────────────────────────────────

async def get_activity_feed(
    db: AsyncSession,
    user_id: uuid.UUID,
    limit: int = 20,
    offset: int = 0,
) -> list[ActivityFeedItem]:
    """Get activity feed from user's network (people they follow)."""
    from app.models.follow import Follow
    from app.models.user_behavior import UserBehavior
    from app.models.user import User

    # Get followed user IDs
    following_result = await db.execute(
        select(Follow.following_id).where(Follow.follower_id == user_id)
    )
    following_ids = [r.following_id for r in following_result.all()]

    if not following_ids:
        return []

    # Get recent public activities from followed users
    week_ago = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=7)

    behaviors = await db.execute(
        select(
            UserBehavior.id,
            UserBehavior.user_id,
            UserBehavior.event_type,
            UserBehavior.target_type,
            UserBehavior.target_id,
            UserBehavior.metadata_json,
            UserBehavior.created_at,
            User.name.label("actor_name"),
        )
        .join(User, User.id == UserBehavior.user_id)
        .where(
            and_(
                UserBehavior.user_id.in_(following_ids),
                UserBehavior.event_type.in_(["purchase", "review", "photo_share", "checkin"]),
                UserBehavior.created_at >= week_ago,
            )
        )
        .order_by(UserBehavior.created_at.desc())
        .offset(offset)
        .limit(limit)
    )

    ACTION_MAP = {
        "purchase": "purchased",
        "review": "reviewed",
        "photo_share": "shared_photo",
        "checkin": "attending",
    }

    items = []
    for row in behaviors.all():
        meta = row.metadata_json or {}
        items.append(ActivityFeedItem(
            id=str(row.id),
            actor_id=str(row.user_id),
            actor_name=row.actor_name or "사용자",
            action=ACTION_MAP.get(row.event_type, row.event_type),
            target_type=row.target_type or "event",
            target_id=str(row.target_id) if row.target_id else "",
            target_title=meta.get("event_title", meta.get("title", "")),
            created_at=row.created_at.isoformat() if row.created_at else "",
            metadata=meta,
        ))

    return items


# ── Social Proof ──────────────────────────────────────────────────────────────

async def get_social_proof(
    db: AsyncSession,
    user_id: uuid.UUID,
    event_id: uuid.UUID,
) -> SocialProof:
    """Get social proof signals for an event."""
    from app.models.follow import Follow
    from app.models.ticket import Ticket
    from app.models.user import User
    from app.models.user_behavior import UserBehavior

    # Get followed user IDs
    following_result = await db.execute(
        select(Follow.following_id).where(Follow.follower_id == user_id)
    )
    following_ids = [r.following_id for r in following_result.all()]

    if not following_ids:
        return SocialProof(
            event_id=str(event_id),
            friends_attending=0,
            friend_names=[],
            network_interest=0,
            trending_in_network=False,
        )

    # Friends with tickets to this event
    friends_with_tickets = await db.execute(
        select(User.name, Ticket.user_id)
        .join(Ticket, Ticket.user_id == User.id)
        .where(
            and_(
                Ticket.event_id == event_id,
                Ticket.user_id.in_(following_ids),
                Ticket.status.in_([TicketStatus.ACTIVE, TicketStatus.USED]),
            )
        )
        .limit(10)
    )
    friend_rows = friends_with_tickets.all()
    friend_names = [r.name for r in friend_rows if r.name]
    friends_count = len(friend_rows)

    # Network interest (views, bids, purchases by friends)
    week_ago = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=7)
    interest_result = await db.execute(
        select(func.count())
        .where(
            and_(
                UserBehavior.user_id.in_(following_ids),
                UserBehavior.target_id == event_id,
                UserBehavior.event_type.in_(["page_view", "bid", "purchase"]),
                UserBehavior.created_at >= week_ago,
            )
        )
    )
    network_interest = interest_result.scalar() or 0

    return SocialProof(
        event_id=str(event_id),
        friends_attending=friends_count,
        friend_names=friend_names[:5],
        network_interest=network_interest,
        trending_in_network=network_interest > 10,
    )


# ── Friend Suggestions ───────────────────────────────────────────────────────

async def get_friend_suggestions(
    db: AsyncSession,
    user_id: uuid.UUID,
    limit: int = 10,
) -> list[FriendSuggestion]:
    """Suggest friends based on mutual connections and shared events."""
    from app.models.follow import Follow
    from app.models.ticket import Ticket
    from app.models.user import User

    # Get who I follow
    following_result = await db.execute(
        select(Follow.following_id).where(Follow.follower_id == user_id)
    )
    my_following = {r.following_id for r in following_result.all()}

    suggestions: dict[uuid.UUID, FriendSuggestion] = {}

    # Strategy 1: Friends of friends (mutual connections)
    if my_following:
        fof_result = await db.execute(
            select(
                Follow.following_id,
                User.name,
                func.count().label("mutual_count"),
            )
            .join(User, User.id == Follow.following_id)
            .where(
                and_(
                    Follow.follower_id.in_(my_following),
                    Follow.following_id != user_id,
                    ~Follow.following_id.in_(my_following),
                )
            )
            .group_by(Follow.following_id, User.name)
            .order_by(func.count().desc())
            .limit(limit)
        )

        for row in fof_result.all():
            suggestions[row.following_id] = FriendSuggestion(
                user_id=str(row.following_id),
                display_name=row.name or "사용자",
                mutual_count=row.mutual_count,
                reason="mutual_friends",
            )

    # Strategy 2: People who attend same events
    my_events = await db.execute(
        select(Ticket.event_id)
        .where(
            and_(
                Ticket.user_id == user_id,
                Ticket.status.in_([TicketStatus.ACTIVE, TicketStatus.USED]),
            )
        )
        .limit(20)
    )
    my_event_ids = [r.event_id for r in my_events.all()]

    if my_event_ids:
        co_attendees = await db.execute(
            select(
                Ticket.user_id,
                User.name,
                func.count().label("shared_events"),
            )
            .join(User, User.id == Ticket.user_id)
            .where(
                and_(
                    Ticket.event_id.in_(my_event_ids),
                    Ticket.user_id != user_id,
                    ~Ticket.user_id.in_(my_following) if my_following else True,
                )
            )
            .group_by(Ticket.user_id, User.name)
            .order_by(func.count().desc())
            .limit(limit)
        )

        for row in co_attendees.all():
            if row.user_id not in suggestions:
                suggestions[row.user_id] = FriendSuggestion(
                    user_id=str(row.user_id),
                    display_name=row.name or "사용자",
                    mutual_count=row.shared_events,
                    reason="same_events",
                )

    return sorted(
        suggestions.values(),
        key=lambda s: s.mutual_count,
        reverse=True,
    )[:limit]


# ── Group Event Planning ──────────────────────────────────────────────────────

async def create_group_invite(
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    invitee_ids: list[uuid.UUID],
) -> dict:
    """Create group invitation for an event."""
    redis = get_redis()
    if redis is None:
        return {"status": "error", "message": "Redis not available"}

    try:
        invite_id = str(uuid.uuid4())[:8]
        key = f"v2:social:group_invite:{invite_id}"

        import json
        await redis.hset(key, mapping={
            "creator": str(user_id),
            "event_id": str(event_id),
            "invitees": json.dumps([str(uid) for uid in invitee_ids]),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": "pending",
        })
        await redis.expire(key, 86400 * 7)  # 7 days

        # Track invites per invitee
        for invitee_id in invitee_ids:
            invite_list_key = f"v2:social:invites:{invitee_id}"
            await redis.lpush(invite_list_key, invite_id)
            await redis.ltrim(invite_list_key, 0, 49)
            await redis.expire(invite_list_key, 86400 * 7)

        return {
            "status": "ok",
            "invite_id": invite_id,
            "invitee_count": len(invitee_ids),
        }
    except Exception:
        return {"status": "error", "message": "Failed to create invite"}


async def get_pending_invites(user_id: uuid.UUID) -> list[dict]:
    """Get pending group invites for a user."""
    redis = get_redis()
    if redis is None:
        return []

    try:
        key = f"v2:social:invites:{user_id}"
        invite_ids = await redis.lrange(key, 0, 19)

        invites = []
        import json
        for iid_bytes in invite_ids:
            iid = iid_bytes.decode() if isinstance(iid_bytes, bytes) else iid_bytes
            invite_key = f"v2:social:group_invite:{iid}"
            data = await redis.hgetall(invite_key)
            if data:
                invite = {}
                for k, v in data.items():
                    dk = k.decode() if isinstance(k, bytes) else k
                    dv = v.decode() if isinstance(v, bytes) else v
                    invite[dk] = dv
                invite["invite_id"] = iid
                if invite.get("invitees"):
                    invite["invitees"] = json.loads(invite["invitees"])
                invites.append(invite)

        return invites
    except Exception:
        return []
