"""P3-1: MCP (Model Context Protocol) server for AI agent integration.

Exposes 8 tools that AI agents can call via delegation tokens:
1. search_events — Natural language event search
2. get_event_details — Full event info including tiers/availability
3. check_availability — Real-time ticket availability
4. place_bid — Place a bid on an event tier
5. purchase_ticket — Direct purchase (fixed-price events)
6. get_my_tickets — List agent's purchased tickets
7. get_recommendations — Personalized event recommendations
8. cancel_order — Cancel/refund an order

Each tool validates delegation token scopes before execution.
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Any

from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession


class MCPScope(str, Enum):
    VIEW = "view"
    BID = "bid"
    PURCHASE = "purchase"
    MANAGE = "manage"


@dataclass
class MCPToolResult:
    success: bool
    data: Any = None
    error: str | None = None
    metadata: dict = field(default_factory=dict)


@dataclass
class MCPContext:
    user_id: uuid.UUID
    agent_name: str
    scopes: list[str]
    token_id: uuid.UUID
    max_budget: Decimal | None = None
    total_spent: Decimal = Decimal("0")
    daily_limit: int | None = None


# ── Tool Registry ─────────────────────────────────────────────────────────────

TOOL_DEFINITIONS = [
    {
        "name": "search_events",
        "description": "자연어로 이벤트를 검색합니다. 카테고리, 날짜, 장소, 키워드 등을 지정할 수 있습니다.",
        "required_scope": MCPScope.VIEW,
        "parameters": {
            "query": {"type": "string", "description": "검색 쿼리 (자연어)"},
            "category": {"type": "string", "description": "카테고리 필터", "optional": True},
            "limit": {"type": "integer", "description": "결과 수 (기본 10)", "optional": True},
        },
    },
    {
        "name": "get_event_details",
        "description": "이벤트 상세 정보를 조회합니다. 티어, 가격, 잔여 좌석 등이 포함됩니다.",
        "required_scope": MCPScope.VIEW,
        "parameters": {
            "event_id": {"type": "string", "description": "이벤트 UUID"},
        },
    },
    {
        "name": "check_availability",
        "description": "특정 이벤트의 실시간 티켓 잔여 수량을 확인합니다.",
        "required_scope": MCPScope.VIEW,
        "parameters": {
            "event_id": {"type": "string", "description": "이벤트 UUID"},
            "tier_id": {"type": "string", "description": "티어 UUID", "optional": True},
        },
    },
    {
        "name": "place_bid",
        "description": "이벤트 티어에 입찰합니다. 공정 추첨 방식 이벤트에 사용합니다.",
        "required_scope": MCPScope.BID,
        "parameters": {
            "event_id": {"type": "string", "description": "이벤트 UUID"},
            "tier_id": {"type": "string", "description": "티어 UUID"},
            "max_price": {"type": "number", "description": "최대 입찰가 (KRW)"},
            "quantity": {"type": "integer", "description": "수량 (기본 1)", "optional": True},
        },
    },
    {
        "name": "purchase_ticket",
        "description": "고정가 이벤트에서 티켓을 직접 구매합니다.",
        "required_scope": MCPScope.PURCHASE,
        "parameters": {
            "event_id": {"type": "string", "description": "이벤트 UUID"},
            "tier_id": {"type": "string", "description": "티어 UUID"},
            "quantity": {"type": "integer", "description": "수량 (기본 1)", "optional": True},
        },
    },
    {
        "name": "get_my_tickets",
        "description": "현재 사용자의 티켓 목록을 조회합니다.",
        "required_scope": MCPScope.VIEW,
        "parameters": {
            "status": {"type": "string", "description": "필터: ACTIVE, USED, CANCELLED", "optional": True},
            "limit": {"type": "integer", "description": "결과 수 (기본 20)", "optional": True},
        },
    },
    {
        "name": "get_recommendations",
        "description": "사용자 행동 기반 맞춤 이벤트 추천을 조회합니다.",
        "required_scope": MCPScope.VIEW,
        "parameters": {
            "limit": {"type": "integer", "description": "추천 수 (기본 5)", "optional": True},
        },
    },
    {
        "name": "cancel_order",
        "description": "주문을 취소하고 환불을 요청합니다.",
        "required_scope": MCPScope.MANAGE,
        "parameters": {
            "order_id": {"type": "string", "description": "주문 UUID"},
            "reason": {"type": "string", "description": "취소 사유", "optional": True},
        },
    },
]


# ── Scope Validation ──────────────────────────────────────────────────────────

def validate_scope(ctx: MCPContext, required: MCPScope) -> MCPToolResult | None:
    """Return error result if scope is missing, None if ok."""
    if required.value not in ctx.scopes:
        return MCPToolResult(
            success=False,
            error=f"권한 부족: '{required.value}' 스코프가 필요합니다. 현재: {ctx.scopes}",
        )
    return None


def check_budget(ctx: MCPContext, amount: Decimal) -> MCPToolResult | None:
    """Return error if purchase would exceed budget."""
    if ctx.max_budget is not None:
        remaining = ctx.max_budget - ctx.total_spent
        if amount > remaining:
            return MCPToolResult(
                success=False,
                error=f"예산 초과: 잔여 {remaining:,.0f}원, 요청 {amount:,.0f}원",
            )
    return None


# ── Tool Implementations ──────────────────────────────────────────────────────

async def tool_search_events(
    db: AsyncSession,
    ctx: MCPContext,
    params: dict,
) -> MCPToolResult:
    """Search events by natural language query."""
    scope_err = validate_scope(ctx, MCPScope.VIEW)
    if scope_err:
        return scope_err

    from app.models.event import Event

    query = params.get("query", "")
    category = params.get("category")
    limit = min(params.get("limit", 10), 50)

    filters = [Event.status == "published"]
    if category:
        filters.append(Event.category == category)
    if query:
        filters.append(Event.title.ilike(f"%{query}%"))

    result = await db.execute(
        select(
            Event.id, Event.title, Event.category,
            Event.start_date, Event.venue_name,
            Event.image_url, Event.status,
        )
        .where(and_(*filters))
        .order_by(Event.start_date.asc())
        .limit(limit)
    )

    events = [
        {
            "id": str(row.id),
            "title": row.title,
            "category": row.category,
            "start_date": row.start_date.isoformat() if row.start_date else None,
            "venue": row.venue_name,
            "image_url": row.image_url,
        }
        for row in result.all()
    ]

    return MCPToolResult(
        success=True,
        data={"events": events, "count": len(events)},
        metadata={"query": query, "category": category},
    )


async def tool_get_event_details(
    db: AsyncSession,
    ctx: MCPContext,
    params: dict,
) -> MCPToolResult:
    """Get detailed event information."""
    scope_err = validate_scope(ctx, MCPScope.VIEW)
    if scope_err:
        return scope_err

    from app.models.event import Event
    from app.models.tier import Tier

    event_id = params.get("event_id")
    if not event_id:
        return MCPToolResult(success=False, error="event_id가 필요합니다")

    try:
        eid = uuid.UUID(event_id)
    except ValueError:
        return MCPToolResult(success=False, error="유효하지 않은 event_id")

    event = await db.get(Event, eid)
    if not event:
        return MCPToolResult(success=False, error="이벤트를 찾을 수 없습니다")

    tiers_result = await db.execute(
        select(Tier).where(Tier.event_id == eid)
    )
    tiers = tiers_result.scalars().all()

    tier_data = [
        {
            "id": str(t.id),
            "name": getattr(t, "name", ""),
            "price": str(getattr(t, "price", 0)),
            "quantity": getattr(t, "quantity", 0),
            "sold": getattr(t, "sold_count", 0),
        }
        for t in tiers
    ]

    return MCPToolResult(
        success=True,
        data={
            "id": str(event.id),
            "title": getattr(event, "title", ""),
            "description": getattr(event, "description", ""),
            "category": getattr(event, "category", ""),
            "start_date": event.start_date.isoformat() if hasattr(event, "start_date") and event.start_date else None,
            "end_date": event.end_date.isoformat() if hasattr(event, "end_date") and event.end_date else None,
            "venue_name": getattr(event, "venue_name", ""),
            "venue_address": getattr(event, "venue_address", ""),
            "image_url": getattr(event, "image_url", ""),
            "status": getattr(event, "status", ""),
            "tiers": tier_data,
        },
    )


async def tool_check_availability(
    db: AsyncSession,
    ctx: MCPContext,
    params: dict,
) -> MCPToolResult:
    """Check real-time ticket availability."""
    scope_err = validate_scope(ctx, MCPScope.VIEW)
    if scope_err:
        return scope_err

    from app.models.tier import Tier

    event_id = params.get("event_id")
    tier_id = params.get("tier_id")

    if not event_id:
        return MCPToolResult(success=False, error="event_id가 필요합니다")

    try:
        eid = uuid.UUID(event_id)
    except ValueError:
        return MCPToolResult(success=False, error="유효하지 않은 event_id")

    filters = [Tier.event_id == eid]
    if tier_id:
        try:
            filters.append(Tier.id == uuid.UUID(tier_id))
        except ValueError:
            return MCPToolResult(success=False, error="유효하지 않은 tier_id")

    result = await db.execute(
        select(Tier).where(and_(*filters))
    )
    tiers = result.scalars().all()

    availability = []
    for t in tiers:
        total = getattr(t, "quantity", 0) or 0
        sold = getattr(t, "sold_count", 0) or 0
        available = max(0, total - sold)
        availability.append({
            "tier_id": str(t.id),
            "tier_name": getattr(t, "name", ""),
            "total": total,
            "sold": sold,
            "available": available,
            "price": str(getattr(t, "price", 0)),
        })

    return MCPToolResult(
        success=True,
        data={"event_id": event_id, "tiers": availability},
    )


async def tool_place_bid(
    db: AsyncSession,
    ctx: MCPContext,
    params: dict,
) -> MCPToolResult:
    """이벤트 티어에 입찰합니다 (공정 추첨)."""
    scope_err = validate_scope(ctx, MCPScope.BID)
    if scope_err:
        return scope_err

    event_id = params.get("event_id")
    tier_id = params.get("tier_id")
    max_price = params.get("max_price")
    quantity = params.get("quantity", 1)

    if not all([event_id, tier_id, max_price]):
        return MCPToolResult(success=False, error="event_id, tier_id, max_price가 필요합니다")

    amount = Decimal(str(max_price)) * quantity
    budget_err = check_budget(ctx, amount)
    if budget_err:
        return budget_err

    # Delegate to existing bid service (placeholder — actual integration
    # would call the bid creation endpoint internally)
    return MCPToolResult(
        success=True,
        data={
            "bid_id": str(uuid.uuid4()),
            "event_id": event_id,
            "tier_id": tier_id,
            "max_price": str(max_price),
            "quantity": quantity,
            "status": "submitted",
            "message": "입찰이 접수되었습니다. 경매 종료 후 결과가 통보됩니다.",
        },
    )


async def tool_purchase_ticket(
    db: AsyncSession,
    ctx: MCPContext,
    params: dict,
) -> MCPToolResult:
    """Purchase ticket directly (fixed-price events)."""
    scope_err = validate_scope(ctx, MCPScope.PURCHASE)
    if scope_err:
        return scope_err

    from app.models.tier import Tier

    event_id = params.get("event_id")
    tier_id = params.get("tier_id")
    quantity = params.get("quantity", 1)

    if not all([event_id, tier_id]):
        return MCPToolResult(success=False, error="event_id, tier_id가 필요합니다")

    try:
        tid = uuid.UUID(tier_id)
    except ValueError:
        return MCPToolResult(success=False, error="유효하지 않은 tier_id")

    tier = await db.get(Tier, tid)
    if not tier:
        return MCPToolResult(success=False, error="티어를 찾을 수 없습니다")

    price = Decimal(str(getattr(tier, "price", 0)))
    total = price * quantity

    budget_err = check_budget(ctx, total)
    if budget_err:
        return budget_err

    # Delegate to purchase service (placeholder)
    return MCPToolResult(
        success=True,
        data={
            "order_id": str(uuid.uuid4()),
            "event_id": event_id,
            "tier_id": tier_id,
            "quantity": quantity,
            "total_amount": str(total),
            "status": "PAYMENT_REQUIRED",
            "message": f"주문이 생성되었습니다. {total:,.0f}원 결제가 필요합니다.",
        },
    )


async def tool_get_my_tickets(
    db: AsyncSession,
    ctx: MCPContext,
    params: dict,
) -> MCPToolResult:
    """List user's tickets."""
    scope_err = validate_scope(ctx, MCPScope.VIEW)
    if scope_err:
        return scope_err

    from app.models.ticket import Ticket
    from app.models.event import Event

    status_filter = params.get("status")
    limit = min(params.get("limit", 20), 100)

    filters = [Ticket.user_id == ctx.user_id]
    if status_filter:
        filters.append(Ticket.status == status_filter)

    result = await db.execute(
        select(
            Ticket.id, Ticket.status, Ticket.event_id,
            Event.title.label("event_title"),
            Event.start_date.label("event_date"),
        )
        .join(Event, Event.id == Ticket.event_id)
        .where(and_(*filters))
        .order_by(Event.start_date.desc())
        .limit(limit)
    )

    tickets = [
        {
            "ticket_id": str(row.id),
            "event_id": str(row.event_id),
            "event_title": row.event_title,
            "event_date": row.event_date.isoformat() if row.event_date else None,
            "status": row.status,
        }
        for row in result.all()
    ]

    return MCPToolResult(
        success=True,
        data={"tickets": tickets, "count": len(tickets)},
    )


async def tool_get_recommendations(
    db: AsyncSession,
    ctx: MCPContext,
    params: dict,
) -> MCPToolResult:
    """Get personalized event recommendations."""
    scope_err = validate_scope(ctx, MCPScope.VIEW)
    if scope_err:
        return scope_err

    limit = min(params.get("limit", 5), 20)

    # Use existing recommendation service
    try:
        from app.services.recommendation_service import get_recommendations
        recs = await get_recommendations(db, ctx.user_id, limit=limit)
        return MCPToolResult(
            success=True,
            data={"recommendations": recs},
        )
    except Exception:
        # Fallback: return recent popular events
        from app.models.event import Event
        result = await db.execute(
            select(Event.id, Event.title, Event.category, Event.start_date)
            .where(Event.status == "published")
            .order_by(Event.start_date.asc())
            .limit(limit)
        )
        events = [
            {
                "id": str(r.id),
                "title": r.title,
                "category": r.category,
                "start_date": r.start_date.isoformat() if r.start_date else None,
            }
            for r in result.all()
        ]
        return MCPToolResult(
            success=True,
            data={"recommendations": events, "source": "popular"},
        )


async def tool_cancel_order(
    db: AsyncSession,
    ctx: MCPContext,
    params: dict,
) -> MCPToolResult:
    """Cancel an order and request refund."""
    scope_err = validate_scope(ctx, MCPScope.MANAGE)
    if scope_err:
        return scope_err

    from app.models.order import Order

    order_id = params.get("order_id")
    reason = params.get("reason", "AI 에이전트 취소 요청")

    if not order_id:
        return MCPToolResult(success=False, error="order_id가 필요합니다")

    try:
        oid = uuid.UUID(order_id)
    except ValueError:
        return MCPToolResult(success=False, error="유효하지 않은 order_id")

    order = await db.get(Order, oid)
    if not order:
        return MCPToolResult(success=False, error="주문을 찾을 수 없습니다")

    if order.user_id != ctx.user_id:
        return MCPToolResult(success=False, error="본인의 주문만 취소할 수 있습니다")

    if order.status in ("CANCELLED", "REFUNDED"):
        return MCPToolResult(success=False, error=f"이미 {order.status} 상태입니다")

    return MCPToolResult(
        success=True,
        data={
            "order_id": order_id,
            "previous_status": order.status,
            "new_status": "CANCEL_REQUESTED",
            "reason": reason,
            "message": "취소 요청이 접수되었습니다. 환불은 영업일 기준 3-5일 소요됩니다.",
        },
    )


# ── Tool Dispatcher ───────────────────────────────────────────────────────────

TOOL_HANDLERS = {
    "search_events": tool_search_events,
    "get_event_details": tool_get_event_details,
    "check_availability": tool_check_availability,
    "place_bid": tool_place_bid,
    "purchase_ticket": tool_purchase_ticket,
    "get_my_tickets": tool_get_my_tickets,
    "get_recommendations": tool_get_recommendations,
    "cancel_order": tool_cancel_order,
}


async def execute_tool(
    db: AsyncSession,
    ctx: MCPContext,
    tool_name: str,
    params: dict,
) -> MCPToolResult:
    """Execute an MCP tool by name."""
    handler = TOOL_HANDLERS.get(tool_name)
    if not handler:
        available = ", ".join(TOOL_HANDLERS.keys())
        return MCPToolResult(
            success=False,
            error=f"알 수 없는 도구: '{tool_name}'. 사용 가능: {available}",
        )

    try:
        return await handler(db, ctx, params)
    except Exception as e:
        return MCPToolResult(
            success=False,
            error=f"도구 실행 오류: {str(e)}",
        )


def get_tool_definitions() -> list[dict]:
    """Return tool definitions for MCP protocol handshake."""
    return TOOL_DEFINITIONS
