"""Partner marketplace API endpoints."""

import logging
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from app.core.errors import ErrorCode, api_error
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_admin
from app.middleware.partner_auth import get_partner
from app.models.partner import Partner, generate_partner_api_key, hash_api_key
from app.models.event import Event, EventStatus
from app.models.user import User
from app.schemas.partner import (
    PartnerRegister,
    PartnerResponse,
    PartnerCreateResponse,
    PartnerEventResponse,
    PartnerEventListResponse,
    PartnerEventTier,
    PartnerInventoryResponse,
    PartnerInventoryItem,
    PartnerOrderCreate,
    PartnerOrderResponse,
)

router = APIRouter()


# -- Admin: Partner Management ---
@router.post("/admin/partners", response_model=PartnerCreateResponse)
async def register_partner(
    data: PartnerRegister,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    raw_key = generate_partner_api_key()
    prefix, hashed = hash_api_key(raw_key)
    partner = Partner(
        name=data.name,
        contact_email=data.contact_email,
        webhook_url=data.webhook_url,
        api_key_hash=hashed,
        api_key_prefix=prefix,
    )
    db.add(partner)
    await db.commit()
    await db.refresh(partner)
    # Return the raw key only at creation time
    response = PartnerCreateResponse.model_validate(partner)
    response.api_key = raw_key
    return response


@router.get("/admin/partners", response_model=list[PartnerResponse])
async def list_partners(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    result = await db.execute(
        select(Partner).order_by(Partner.created_at.desc()).offset(skip).limit(limit)
    )
    return list(result.scalars().all())


# -- Partner API: Events ---
@router.get("/partners/events", response_model=PartnerEventListResponse)
async def partner_list_events(
    category: str | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    partner: Partner = Depends(get_partner),
    db: AsyncSession = Depends(get_read_db),
):
    open_statuses = [
        EventStatus.BIDDING_OPEN.value
        if hasattr(EventStatus.BIDDING_OPEN, "value")
        else "bidding_open",
        "bidding_open",
    ]
    query = select(Event).where(Event.status.in_(open_statuses))
    count_query = select(func.count(Event.id)).where(Event.status.in_(open_statuses))

    if category:
        query = query.where(Event.category == category)
        count_query = count_query.where(Event.category == category)

    total = (await db.execute(count_query)).scalar() or 0
    result = await db.execute(query.order_by(Event.event_date.asc()).offset(skip).limit(limit))
    events = result.scalars().all()

    items = []
    for e in events:
        items.append(
            PartnerEventResponse(
                id=e.id,
                title={"ko": e.title, "en": e.title},  # TODO: Add multi-lang title field
                venue_name=getattr(e, "venue", "") or "",
                venue_city=getattr(e, "location_city", "") or "",
                venue_country="KR",
                datetime=e.event_date.isoformat() if e.event_date else "",
                timezone=getattr(e, "event_timezone", "Asia/Seoul") or "Asia/Seoul",
                currency=getattr(e, "currency", "KRW") or "KRW",
                category=e.category or "",
                status=e.status.value if hasattr(e.status, "value") else str(e.status),
            )
        )

    return PartnerEventListResponse(events=items, total=total)


@router.get("/partners/events/{event_id}", response_model=PartnerEventResponse)
async def partner_get_event(
    event_id: uuid.UUID,
    partner: Partner = Depends(get_partner),
    db: AsyncSession = Depends(get_read_db),
):
    result = await db.execute(select(Event).where(Event.id == event_id))
    e = result.scalar_one_or_none()
    if not e:
        raise HTTPException(404, "Event not found")

    # Get tiers
    tiers = []
    try:
        from app.models.event import SeatTier

        tier_result = await db.execute(select(SeatTier).where(SeatTier.event_id == event_id))
        for t in tier_result.scalars().all():
            tiers.append(
                PartnerEventTier(
                    id=t.id,
                    name={"ko": t.name, "en": t.name},
                    price=float(t.base_price),
                    currency=getattr(e, "currency", "KRW") or "KRW",
                    available=t.capacity - (getattr(t, "sold_count", 0) or 0),
                )
            )
    except Exception:
        logger.warning("Failed to load tiers for event %s", event_id, exc_info=True)

    return PartnerEventResponse(
        id=e.id,
        title={"ko": e.title, "en": e.title},
        venue_name=getattr(e, "venue", "") or "",
        venue_city=getattr(e, "location_city", "") or "",
        venue_country="KR",
        datetime=e.event_date.isoformat() if e.event_date else "",
        timezone=getattr(e, "event_timezone", "Asia/Seoul") or "Asia/Seoul",
        currency=getattr(e, "currency", "KRW") or "KRW",
        category=e.category or "",
        status=e.status.value if hasattr(e.status, "value") else str(e.status),
        tiers=tiers,
    )


@router.get("/partners/inventory/{event_id}", response_model=PartnerInventoryResponse)
async def partner_get_inventory(
    event_id: uuid.UUID,
    partner: Partner = Depends(get_partner),
    db: AsyncSession = Depends(get_read_db),
):
    result = await db.execute(select(Event).where(Event.id == event_id))
    e = result.scalar_one_or_none()
    if not e:
        raise HTTPException(404, "Event not found")

    inventory = []
    try:
        from app.models.event import SeatTier

        tier_result = await db.execute(select(SeatTier).where(SeatTier.event_id == event_id))
        for t in tier_result.scalars().all():
            inventory.append(
                PartnerInventoryItem(
                    tier_id=t.id,
                    tier_name=t.name,
                    total=t.capacity,
                    available=t.capacity - (getattr(t, "sold_count", 0) or 0),
                    price=float(t.base_price),
                    currency=getattr(e, "currency", "KRW") or "KRW",
                )
            )
    except Exception:
        logger.warning("Failed to load inventory for event %s", event_id, exc_info=True)

    return PartnerInventoryResponse(event_id=event_id, inventory=inventory)


@router.post("/partners/orders", response_model=PartnerOrderResponse)
async def partner_create_order(
    data: PartnerOrderCreate,
    partner: Partner = Depends(get_partner),
    db: AsyncSession = Depends(get_db),
):
    """파트너 플랫폼에서 주문을 생성합니다. 실제 DB에 저장됩니다."""
    from app.models.event import SeatTier
    from app.models.partner import PartnerOrder

    # 이벤트 확인
    result = await db.execute(select(Event).where(Event.id == data.event_id))
    event = result.scalar_one_or_none()
    if not event:
        raise api_error(ErrorCode.EVENT_NOT_FOUND, "Event not found")

    # 티어 확인 및 가격 조회
    tier_result = await db.execute(
        select(SeatTier).where(SeatTier.id == data.tier_id, SeatTier.event_id == data.event_id)
    )
    tier = tier_result.scalar_one_or_none()
    if not tier:
        raise api_error(ErrorCode.TIER_NOT_FOUND, "Requested seat tier not found for this event")

    # 재고 확인
    available = tier.capacity - (tier.sold_count or 0)
    if data.quantity > available:
        raise api_error(
            ErrorCode.INSUFFICIENT_STOCK,
            f"Insufficient stock: requested {data.quantity}, available {available}",
        )

    # 금액 계산
    unit_price = float(tier.base_price)
    total_amount = unit_price * data.quantity

    # DB에 파트너 주문 생성
    order = PartnerOrder(
        partner_id=partner.id,
        event_id=data.event_id,
        tier_id=data.tier_id,
        quantity=data.quantity,
        unit_price=unit_price,
        total_amount=total_amount,
        payment_currency=data.payment_currency,
        buyer_email=data.buyer_email,
        buyer_name=data.buyer_name,
        buyer_country=data.buyer_country,
    )
    db.add(order)
    await db.commit()
    await db.refresh(order)

    return PartnerOrderResponse(
        id=order.id,
        event_id=order.event_id,
        status=order.status.value,
        amount=order.total_amount,
        currency=order.payment_currency,
        created_at=order.created_at,
    )


@router.get("/partners/orders/{order_id}", response_model=PartnerOrderResponse)
async def partner_get_order(
    order_id: uuid.UUID,
    partner: Partner = Depends(get_partner),
    db: AsyncSession = Depends(get_read_db),
):
    from app.models.partner import PartnerOrder

    result = await db.execute(
        select(PartnerOrder).where(
            PartnerOrder.id == order_id,
            PartnerOrder.partner_id == partner.id,
        )
    )
    order = result.scalar_one_or_none()
    if not order:
        raise api_error(ErrorCode.ORDER_NOT_FOUND, "Order not found")

    return PartnerOrderResponse(
        id=order.id,
        event_id=order.event_id,
        status=order.status.value,
        amount=order.total_amount,
        currency=order.payment_currency,
        created_at=order.created_at,
    )
