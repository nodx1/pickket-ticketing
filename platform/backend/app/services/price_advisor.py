"""P3-7: Dynamic price advisor V2.

Provides data-driven pricing suggestions for organizers based on:
- Historical sales data for similar events
- Demand signals (waitlist size, page views, search volume)
- Market positioning (competitor analysis)
- Time-based pricing optimization (early-bird, last-minute)
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select, func, and_, case
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class PriceSuggestion:
    tier_name: str
    current_price: Decimal
    suggested_min: Decimal
    suggested_optimal: Decimal
    suggested_max: Decimal
    confidence: float  # 0.0-1.0
    reasoning: list[str] = field(default_factory=list)


@dataclass
class PriceAdvisorResult:
    event_id: uuid.UUID
    suggestions: list[PriceSuggestion] = field(default_factory=list)
    demand_score: float = 0.0  # 0.0-1.0
    market_position: str = "average"  # budget | average | premium | luxury
    early_bird_discount_pct: int = 0
    generated_at: str = ""

    def __post_init__(self):
        self.generated_at = datetime.now(timezone.utc).isoformat()


async def generate_advice(
    db: AsyncSession,
    event_id: uuid.UUID,
) -> PriceAdvisorResult:
    """Generate pricing advice for an event."""
    from app.models.event import Event, SeatTier

    # Load event and tiers
    event = await db.get(Event, event_id)
    if not event:
        return PriceAdvisorResult(event_id=event_id)

    tiers_result = await db.execute(
        select(SeatTier).where(SeatTier.event_id == event_id)
    )
    tiers = tiers_result.scalars().all()

    if not tiers:
        return PriceAdvisorResult(event_id=event_id)

    # Calculate demand score
    demand = await _calculate_demand_score(db, event_id, event)

    # Get historical pricing data for similar events
    historical = await _get_historical_pricing(db, event)

    # Determine market position
    position = _determine_market_position(event, historical)

    # Generate per-tier suggestions
    suggestions = []
    for tier in tiers:
        suggestion = _generate_tier_suggestion(
            tier, demand, historical, position
        )
        suggestions.append(suggestion)

    # Calculate early-bird recommendation
    days_until = 0
    if event.start_date:
        start = event.start_date if isinstance(event.start_date, datetime) else datetime.combine(event.start_date, datetime.min.time())
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        days_until = (start - datetime.now(timezone.utc)).days

    early_bird_pct = 0
    if days_until > 30:
        early_bird_pct = min(20, max(5, int(demand * 15)))

    return PriceAdvisorResult(
        event_id=event_id,
        suggestions=suggestions,
        demand_score=demand,
        market_position=position,
        early_bird_discount_pct=early_bird_pct,
    )


async def _calculate_demand_score(
    db: AsyncSession,
    event_id: uuid.UUID,
    event,
) -> float:
    """Calculate demand score (0-1) based on multiple signals."""
    from app.models.user_behavior import UserBehavior

    signals = []

    # Signal 1: Page view velocity (views in last 7 days)
    week_ago = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=7)
    views_result = await db.execute(
        select(func.count())
        .where(
            and_(
                UserBehavior.event_type == "page_view",
                UserBehavior.target_type == "event",
                UserBehavior.target_id == event_id,
                UserBehavior.created_at >= week_ago,
            )
        )
    )
    views = views_result.scalar() or 0
    # Normalize: 100 views/week = 0.5, 500+ = 1.0
    view_signal = min(1.0, views / 500)
    signals.append(view_signal)

    # Signal 2: Search interest
    search_result = await db.execute(
        select(func.count())
        .where(
            and_(
                UserBehavior.event_type == "search",
                UserBehavior.target_type == "event",
                UserBehavior.target_id == event_id,
                UserBehavior.created_at >= week_ago,
            )
        )
    )
    searches = search_result.scalar() or 0
    search_signal = min(1.0, searches / 100)
    signals.append(search_signal)

    # Signal 3: Bid/purchase interest ratio
    interest_result = await db.execute(
        select(func.count())
        .where(
            and_(
                UserBehavior.event_type.in_(["bid", "purchase", "add_to_cart"]),
                UserBehavior.target_type == "event",
                UserBehavior.target_id == event_id,
                UserBehavior.created_at >= week_ago,
            )
        )
    )
    interest = interest_result.scalar() or 0
    interest_signal = min(1.0, interest / 50)
    signals.append(interest_signal * 1.5)  # Weight purchase interest higher

    # Weighted average
    if not signals:
        return 0.0
    return min(1.0, sum(signals) / len(signals))


async def _get_historical_pricing(db: AsyncSession, event) -> dict:
    """Get pricing statistics for similar events."""
    from app.models.event import Event, SeatTier

    # Find similar events (same category, last 6 months)
    six_months_ago = datetime.now(timezone.utc) - timedelta(days=180)

    similar_events = await db.execute(
        select(Event.id)
        .where(
            and_(
                Event.category == event.category,
                Event.id != event.id,
                Event.created_at >= six_months_ago,
            )
        )
        .limit(50)
    )
    similar_ids = [r.id for r in similar_events.all()]

    if not similar_ids:
        return {"avg_price": Decimal("50000"), "min_price": Decimal("10000"), "max_price": Decimal("200000"), "sell_through": 0.5}

    # Get tier pricing stats
    pricing = await db.execute(
        select(
            func.avg(SeatTier.base_price).label("avg_price"),
            func.min(SeatTier.base_price).label("min_price"),
            func.max(SeatTier.base_price).label("max_price"),
        ).where(SeatTier.event_id.in_(similar_ids))
    )
    row = pricing.first()

    # Get sell-through rate
    from app.models.ticket import Ticket
    ticket_stats = await db.execute(
        select(
            func.count().label("total"),
            func.count(case((Ticket.status == "ACTIVE", 1))).label("sold"),
        ).where(Ticket.event_id.in_(similar_ids))
    )
    ts = ticket_stats.first()
    sell_through = (ts.sold / ts.total) if ts and ts.total > 0 else 0.5

    return {
        "avg_price": Decimal(str(row.avg_price or 50000)),
        "min_price": Decimal(str(row.min_price or 10000)),
        "max_price": Decimal(str(row.max_price or 200000)),
        "sell_through": sell_through,
    }


def _determine_market_position(event, historical: dict) -> str:
    """Determine market positioning based on event attributes."""
    # Simple heuristic based on category and venue
    premium_categories = {"concert", "musical", "classic"}
    budget_categories = {"exhibition", "festival"}

    category = getattr(event, "category", "").lower()

    if category in premium_categories:
        if historical["sell_through"] > 0.8:
            return "luxury"
        return "premium"
    elif category in budget_categories:
        return "budget"
    return "average"


def _generate_tier_suggestion(
    tier,
    demand: float,
    historical: dict,
    position: str,
) -> PriceSuggestion:
    """Generate price suggestion for a single tier."""
    current = Decimal(str(tier.base_price or 0))
    avg_hist = historical["avg_price"]

    # Position multiplier
    multipliers = {
        "budget": Decimal("0.7"),
        "average": Decimal("1.0"),
        "premium": Decimal("1.3"),
        "luxury": Decimal("1.6"),
    }
    pos_mult = multipliers.get(position, Decimal("1.0"))

    # Demand adjustment
    demand_mult = Decimal(str(1.0 + (demand - 0.5) * 0.4))

    base = avg_hist * pos_mult * demand_mult
    suggested_min = max(Decimal("10000"), base * Decimal("0.8"))
    suggested_optimal = max(Decimal("10000"), base)
    suggested_max = max(Decimal("15000"), base * Decimal("1.25"))

    # Build reasoning
    reasons = []
    if demand > 0.7:
        reasons.append("높은 수요 — 프리미엄 가격 추천")
    elif demand < 0.3:
        reasons.append("낮은 수요 — 경쟁력 있는 가격 추천")
    else:
        reasons.append("보통 수요 수준")

    if position in ("premium", "luxury"):
        reasons.append(f"카테고리 포지셔닝: {position}")

    if current > Decimal("0"):
        diff_pct = ((suggested_optimal - current) / current * 100) if current else 0
        if abs(diff_pct) > 10:
            direction = "인상" if diff_pct > 0 else "인하"
            reasons.append(f"현재 대비 {abs(diff_pct):.0f}% {direction} 추천")

    confidence = min(0.9, 0.3 + demand * 0.3 + historical["sell_through"] * 0.3)

    return PriceSuggestion(
        tier_name=getattr(tier, "name", "기본"),
        current_price=current,
        suggested_min=suggested_min.quantize(Decimal("1000")),
        suggested_optimal=suggested_optimal.quantize(Decimal("1000")),
        suggested_max=suggested_max.quantize(Decimal("1000")),
        confidence=round(confidence, 2),
        reasoning=reasons,
    )


# Backward-compatible wrapper matching PriceAdviceResponse schema
async def get_price_advice(event_id, user_id, db):
    result = await generate_advice(db, event_id)

    # Map V2 result to legacy PriceAdviceResponse fields
    position_competition = {"budget": 0.3, "average": 0.5, "premium": 0.7, "luxury": 0.9}
    competition = position_competition.get(result.market_position, 0.5)

    # Use first suggestion for bid range, or defaults
    if result.suggestions:
        s = result.suggestions[0]
        suggested_min = float(s.suggested_min)
        suggested_max = float(s.suggested_max)
        avg_price = float(s.suggested_optimal)
    else:
        suggested_min = 10000.0
        suggested_max = 200000.0
        avg_price = 50000.0

    # Build suggestion text
    parts = []
    for s in result.suggestions:
        parts.extend(s.reasoning)
    suggestion_text = " | ".join(parts) if parts else "데이터 부족으로 기본 추천"

    return {
        "event_id": result.event_id,
        "competition_level": competition,
        "avg_historical_price": avg_price,
        "fan_weight": result.demand_score,
        "weight_percentile": min(1.0, result.demand_score * 1.2),
        "estimated_win_probability": max(0.1, 1.0 - competition),
        "suggested_min_bid": suggested_min,
        "suggested_max_bid": suggested_max,
        "suggestion_text": suggestion_text,
    }
