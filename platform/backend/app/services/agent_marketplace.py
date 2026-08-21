"""P3-2: AI Agent Marketplace.

Registry and marketplace for AI agents that integrate with Pickket:
- Agent registration and verification
- Agent discovery and search
- Usage analytics per agent
- Rating/review system for agents
- Agent capability declarations (which MCP tools they use)
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum

import json
from typing import Any

from app.core.redis import get_redis


MARKETPLACE_CACHE_TTL = 7 * 86400


class AgentStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    SUSPENDED = "suspended"
    DEPRECATED = "deprecated"


class AgentCategory(str, Enum):
    TICKET_BUYER = "ticket_buyer"
    PRICE_TRACKER = "price_tracker"
    EVENT_SCOUT = "event_scout"
    GROUP_COORDINATOR = "group_coordinator"
    RESALE_MONITOR = "resale_monitor"
    ANALYTICS = "analytics"
    NOTIFICATION = "notification"
    CUSTOM = "custom"


@dataclass
class AgentListing:
    id: str
    name: str
    description: str
    developer_id: str
    developer_name: str
    category: AgentCategory
    capabilities: list[str]  # MCP tool names this agent uses
    icon_url: str = ""
    website_url: str = ""
    status: AgentStatus = AgentStatus.PENDING
    version: str = "1.0.0"
    min_scopes: list[str] = field(default_factory=list)  # Required delegation scopes
    rating: float = 0.0
    review_count: int = 0
    install_count: int = 0
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "developer_id": self.developer_id,
            "developer_name": self.developer_name,
            "category": self.category.value,
            "capabilities": self.capabilities,
            "icon_url": self.icon_url,
            "website_url": self.website_url,
            "status": self.status.value,
            "version": self.version,
            "min_scopes": self.min_scopes,
            "rating": self.rating,
            "review_count": self.review_count,
            "install_count": self.install_count,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "AgentListing":
        return cls(
            id=d["id"],
            name=d["name"],
            description=d["description"],
            developer_id=d["developer_id"],
            developer_name=d.get("developer_name", ""),
            category=AgentCategory(d.get("category", "custom")),
            capabilities=d.get("capabilities", []),
            icon_url=d.get("icon_url", ""),
            website_url=d.get("website_url", ""),
            status=AgentStatus(d.get("status", "pending")),
            version=d.get("version", "1.0.0"),
            min_scopes=d.get("min_scopes", []),
            rating=d.get("rating", 0.0),
            review_count=d.get("review_count", 0),
            install_count=d.get("install_count", 0),
            created_at=d.get("created_at", ""),
            updated_at=d.get("updated_at", ""),
        )


@dataclass
class AgentReview:
    id: str
    agent_id: str
    user_id: str
    rating: int  # 1-5
    comment: str
    created_at: str


async def _sadd_with_ttl(redis: Any, key: str, *values: str, ttl: int) -> None:
    await redis.sadd(key, *values)  # expire below
    await redis.expire(key, ttl)


# ── Agent Registration ────────────────────────────────────────────────────────

async def register_agent(listing: AgentListing) -> dict:
    """Register a new agent in the marketplace."""
    redis = get_redis()
    if redis is None:
        return {"success": False, "error": "Storage unavailable"}

    try:
        if not listing.id:
            listing.id = str(uuid.uuid4())[:12]
        listing.created_at = datetime.now(timezone.utc).isoformat()
        listing.updated_at = listing.created_at
        listing.status = AgentStatus.PENDING

        # Store agent data
        key = f"v2:marketplace:agent:{listing.id}"
        await redis.set(key, json.dumps(listing.to_dict()), ex=MARKETPLACE_CACHE_TTL)

        # Add to category index
        cat_key = f"v2:marketplace:cat:{listing.category.value}"
        await _sadd_with_ttl(redis, cat_key, listing.id, ttl=MARKETPLACE_CACHE_TTL)

        # Add to pending review queue
        await _sadd_with_ttl(
            redis,
            "v2:marketplace:pending",
            listing.id,
            ttl=MARKETPLACE_CACHE_TTL,
        )

        # Add to full index
        await _sadd_with_ttl(
            redis,
            "v2:marketplace:all",
            listing.id,
            ttl=MARKETPLACE_CACHE_TTL,
        )

        return {"success": True, "agent_id": listing.id}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def approve_agent(agent_id: str) -> bool:
    """Approve a pending agent listing."""
    redis = get_redis()
    if redis is None:
        return False

    try:
        key = f"v2:marketplace:agent:{agent_id}"
        data = await redis.get(key)
        if not data:
            return False

        raw = data.decode() if isinstance(data, bytes) else data
        listing = AgentListing.from_dict(json.loads(raw))
        listing.status = AgentStatus.APPROVED
        listing.updated_at = datetime.now(timezone.utc).isoformat()

        await redis.set(key, json.dumps(listing.to_dict()), ex=MARKETPLACE_CACHE_TTL)
        await redis.srem("v2:marketplace:pending", agent_id)
        await _sadd_with_ttl(
            redis,
            "v2:marketplace:approved",
            agent_id,
            ttl=MARKETPLACE_CACHE_TTL,
        )

        return True
    except Exception:
        return False


async def suspend_agent(agent_id: str, reason: str = "") -> bool:
    """Suspend an agent listing."""
    redis = get_redis()
    if redis is None:
        return False

    try:
        key = f"v2:marketplace:agent:{agent_id}"
        data = await redis.get(key)
        if not data:
            return False

        raw = data.decode() if isinstance(data, bytes) else data
        listing = AgentListing.from_dict(json.loads(raw))
        listing.status = AgentStatus.SUSPENDED
        listing.updated_at = datetime.now(timezone.utc).isoformat()

        await redis.set(key, json.dumps(listing.to_dict()), ex=MARKETPLACE_CACHE_TTL)
        await redis.srem("v2:marketplace:approved", agent_id)

        if reason:
            await redis.hset(f"v2:marketplace:suspension:{agent_id}", mapping={
                "reason": reason,
                "suspended_at": listing.updated_at,
            })

        return True
    except Exception:
        return False


# ── Agent Discovery ───────────────────────────────────────────────────────────

async def search_agents(
    query: str = "",
    category: str | None = None,
    limit: int = 20,
) -> list[AgentListing]:
    """Search approved agents in the marketplace."""
    redis = get_redis()
    if redis is None:
        return []

    try:
        if category:
            agent_ids = await redis.sinter(
                f"v2:marketplace:cat:{category}",
                "v2:marketplace:approved",
            )
        else:
            agent_ids = await redis.smembers("v2:marketplace:approved")

        listings = []
        for aid_bytes in agent_ids:
            aid = aid_bytes.decode() if isinstance(aid_bytes, bytes) else aid_bytes
            data = await redis.get(f"v2:marketplace:agent:{aid}")
            if data:
                raw = data.decode() if isinstance(data, bytes) else data
                listing = AgentListing.from_dict(json.loads(raw))

                # Filter by query
                if query:
                    q_lower = query.lower()
                    if (q_lower not in listing.name.lower() and
                        q_lower not in listing.description.lower()):
                        continue

                listings.append(listing)

        # Sort by rating then install count
        listings.sort(key=lambda a: (a.rating, a.install_count), reverse=True)
        return listings[:limit]
    except Exception:
        return []


async def get_agent(agent_id: str) -> AgentListing | None:
    """Get a single agent listing."""
    redis = get_redis()
    if redis is None:
        return None

    try:
        data = await redis.get(f"v2:marketplace:agent:{agent_id}")
        if not data:
            return None
        raw = data.decode() if isinstance(data, bytes) else data
        return AgentListing.from_dict(json.loads(raw))
    except Exception:
        return None


async def get_popular_agents(limit: int = 10) -> list[AgentListing]:
    """Get most popular agents by install count."""
    return await search_agents(limit=limit)


# ── Install/Uninstall ─────────────────────────────────────────────────────────

async def install_agent(user_id: str, agent_id: str) -> dict:
    """User installs (connects) an agent."""
    redis = get_redis()
    if redis is None:
        return {"success": False, "error": "Storage unavailable"}

    try:
        # Check agent exists and is approved
        agent = await get_agent(agent_id)
        if not agent:
            return {"success": False, "error": "Agent not found"}
        if agent.status != AgentStatus.APPROVED:
            return {"success": False, "error": "Agent is not available"}

        # Add to user's installed agents
        await _sadd_with_ttl(
            redis,
            f"v2:marketplace:user_agents:{user_id}",
            agent_id,
            ttl=MARKETPLACE_CACHE_TTL,
        )

        # Increment install count
        agent.install_count += 1
        agent.updated_at = datetime.now(timezone.utc).isoformat()
        await redis.set(f"v2:marketplace:agent:{agent_id}", json.dumps(agent.to_dict()), ex=MARKETPLACE_CACHE_TTL)

        # Track usage
        await redis.hincrby("v2:marketplace:installs", agent_id, 1)

        return {
            "success": True,
            "agent_id": agent_id,
            "required_scopes": agent.min_scopes,
            "message": f"{agent.name} 에이전트가 연결되었습니다. 위임 토큰에 {agent.min_scopes} 스코프가 필요합니다.",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def uninstall_agent(user_id: str, agent_id: str) -> bool:
    """User uninstalls (disconnects) an agent."""
    redis = get_redis()
    if redis is None:
        return False

    try:
        await redis.srem(f"v2:marketplace:user_agents:{user_id}", agent_id)
        return True
    except Exception:
        return False


async def get_user_agents(user_id: str) -> list[AgentListing]:
    """Get agents installed by a user."""
    redis = get_redis()
    if redis is None:
        return []

    try:
        agent_ids = await redis.smembers(f"v2:marketplace:user_agents:{user_id}")
        agents = []
        for aid_bytes in agent_ids:
            aid = aid_bytes.decode() if isinstance(aid_bytes, bytes) else aid_bytes
            agent = await get_agent(aid)
            if agent:
                agents.append(agent)
        return agents
    except Exception:
        return []


# ── Reviews ───────────────────────────────────────────────────────────────────

async def add_review(
    agent_id: str,
    user_id: str,
    rating: int,
    comment: str,
) -> dict:
    """Add a review for an agent."""
    redis = get_redis()
    if redis is None:
        return {"success": False, "error": "Storage unavailable"}

    if not 1 <= rating <= 5:
        return {"success": False, "error": "Rating must be 1-5"}

    try:
        review_id = str(uuid.uuid4())[:8]
        review = AgentReview(
            id=review_id,
            agent_id=agent_id,
            user_id=user_id,
            rating=rating,
            comment=comment,
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        # Store review
        review_key = f"v2:marketplace:reviews:{agent_id}"
        await redis.lpush(review_key, json.dumps({
            "id": review.id,
            "user_id": review.user_id,
            "rating": review.rating,
            "comment": review.comment,
            "created_at": review.created_at,
        }))
        await redis.ltrim(review_key, 0, 99)  # Keep last 100

        # Update agent rating
        agent = await get_agent(agent_id)
        if agent:
            reviews_data = await redis.lrange(review_key, 0, -1)
            ratings = []
            for rd in reviews_data:
                raw = rd.decode() if isinstance(rd, bytes) else rd
                r = json.loads(raw)
                ratings.append(r["rating"])

            agent.rating = round(sum(ratings) / len(ratings), 1) if ratings else 0
            agent.review_count = len(ratings)
            agent.updated_at = datetime.now(timezone.utc).isoformat()
            await redis.set(f"v2:marketplace:agent:{agent_id}", json.dumps(agent.to_dict()), ex=MARKETPLACE_CACHE_TTL)

        return {"success": True, "review_id": review_id}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def get_reviews(agent_id: str, limit: int = 20) -> list[dict]:
    """Get reviews for an agent."""
    redis = get_redis()
    if redis is None:
        return []

    try:
        review_key = f"v2:marketplace:reviews:{agent_id}"
        reviews_data = await redis.lrange(review_key, 0, limit - 1)
        reviews = []
        for rd in reviews_data:
            raw = rd.decode() if isinstance(rd, bytes) else rd
            reviews.append(json.loads(raw))
        return reviews
    except Exception:
        return []


# ── Analytics ─────────────────────────────────────────────────────────────────

async def record_agent_usage(agent_id: str, tool_name: str) -> None:
    """Record tool usage for agent analytics."""
    redis = get_redis()
    if redis is None:
        return

    try:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        usage_key = f"v2:marketplace:usage:{agent_id}:{today}"
        await redis.hincrby(usage_key, tool_name, 1)
        await redis.expire(usage_key, 86400 * 30)  # Keep 30 days

        total_key = f"v2:marketplace:usage_total:{agent_id}"
        await redis.hincrby(total_key, tool_name, 1)
    except Exception:
        pass


async def get_agent_analytics(agent_id: str, days: int = 7) -> dict:
    """Get usage analytics for an agent."""
    redis = get_redis()
    if redis is None:
        return {}

    try:
        from datetime import timedelta
        analytics = {"daily": {}, "total_calls": 0, "tool_breakdown": {}}

        for i in range(days):
            date = (datetime.now(timezone.utc) - timedelta(days=i)).strftime("%Y-%m-%d")
            usage_key = f"v2:marketplace:usage:{agent_id}:{date}"
            data = await redis.hgetall(usage_key)
            daily_total = 0
            for k, v in data.items():
                tool = k.decode() if isinstance(k, bytes) else k
                count = int(v.decode() if isinstance(v, bytes) else v)
                daily_total += count
                analytics["tool_breakdown"][tool] = analytics["tool_breakdown"].get(tool, 0) + count
            analytics["daily"][date] = daily_total
            analytics["total_calls"] += daily_total

        return analytics
    except Exception:
        return {}
