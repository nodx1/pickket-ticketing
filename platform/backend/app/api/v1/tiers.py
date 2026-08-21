"""Seat tier management endpoints (organizer creates/updates tiers)."""

import logging
import uuid

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.feature_gate import ensure_sale_mode_enabled
from app.middleware.auth import get_current_organizer
from app.models.event import Event, EventStatus, SeatTier
from app.models.user import User
from app.schemas.seat_tier import SeatTierCreate, SeatTierResponse, SeatTierUpdate

router = APIRouter()


@router.post(
    "/{event_id}/tiers",
    response_model=SeatTierResponse,
    status_code=status.HTTP_201_CREATED,
    summary="좌석 등급 생성",
    description="이벤트에 새로운 좌석 등급(tier)을 생성합니다. 주최자 권한 필요. 판매 방식(선착순/공정 추첨/대기열/멤버십 선판매), 가격, 수용 인원 등을 설정합니다.",
    openapi_extra={"x-agent-hint": "Organizer-only. POST SeatTierCreate with name, capacity, base_price, sale_mode (fixed_fcfs/point_lottery/queue/fanclub_presale), pricing bounds, seating_type, resale settings."},
)
async def create_tier(
    event_id: uuid.UUID,
    data: SeatTierCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Create a new seat tier for an event. Organizer only."""
    # Verify event exists and belongs to organizer
    result = await db.execute(
        select(Event).where(Event.id == event_id, Event.organizer_id == user.id)
    )
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    await ensure_sale_mode_enabled(data.sale_mode)

    tier = SeatTier(
        event_id=event_id,
        name=data.name,
        capacity=data.capacity,
        base_price=data.base_price,
        sale_mode=data.sale_mode,
        face_price=data.face_price,
        min_price=data.min_price,
        max_price_cap=data.max_price_cap,
        lottery_application_hours=data.lottery_application_hours,
        fanclub_discount_pct=data.fanclub_discount_pct,
        allow_group_tickets=data.allow_group_tickets,
        max_group_size=data.max_group_size,
        bidding_opens_at=data.bidding_opens_at,
        bidding_closes_at=data.bidding_closes_at,
        # View metadata
        view_description=data.view_description,
        distance_from_stage=data.distance_from_stage,
        view_rating=data.view_rating,
        view_image_url=data.view_image_url,
        position_label=data.position_label,
        # Seating & resale
        seating_type=data.seating_type,
        section_name=data.section_name,
        resale_allowed=data.resale_allowed,
        resale_max_price=data.resale_max_price,
    )
    db.add(tier)
    await db.commit()
    await db.refresh(tier)

    resp = SeatTierResponse.model_validate(tier)
    resp.remaining = tier.capacity - tier.sold_count
    return resp


@router.get(
    "/{event_id}/tiers",
    response_model=list[SeatTierResponse],
    summary="이벤트 좌석 등급 목록",
    description="이벤트의 모든 좌석 등급을 가격 오름차순으로 조회합니다. 잔여 좌석 수(remaining)가 포함됩니다. 인증 불필요.",
    openapi_extra={"x-agent-hint": "Public endpoint. Pass event_id. Returns list of SeatTierResponse sorted by base_price ASC, each with remaining count."},
)
async def list_tiers(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """List all seat tiers for an event. Public endpoint."""
    # Verify event exists
    event_result = await db.execute(select(Event).where(Event.id == event_id))
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # 🔴 **공개 엔드포인트는 숨김·비활성 티어를 내보내지 않는다** (2026-08-02).
    #    종전엔 조건 없이 전부 반환했다. 그래서 내부용 초대권(0원·정원 100만·
    #    visibility=hidden)의 id 가 인증 없이 새어나갔고, 그 id 로 공개 게스트 주문을
    #    만들면 0원 자동확정으로 **무료 티켓이 ACTIVE 로 발권**됐다.
    #    ⚠️ 이 필터는 id 유출을 막는 것이고, **발권 차단 자체는 주문 생성 경로**
    #       (`internal_commerce._do_create_order` 의 공개 진입점 가드)가 한다.
    #       여기만 고치면 id 를 이미 아는 사람은 그대로 통과한다 — 둘 다 필요하다.
    result = await db.execute(
        select(SeatTier)
        .where(
            SeatTier.event_id == event_id,
            SeatTier.visibility == "public",
            SeatTier.is_active.is_(True),
        )
        .order_by(SeatTier.base_price.asc())
    )
    tiers = result.scalars().all()

    responses = []
    for tier in tiers:
        resp = SeatTierResponse.model_validate(tier)
        resp.remaining = tier.capacity - tier.sold_count
        responses.append(resp)
    return responses


@router.patch(
    "/{event_id}/tiers/{tier_id}",
    response_model=SeatTierResponse,
    summary="좌석 등급 수정",
    description="좌석 등급 정보를 수정합니다. 주최자 권한 필요. 입찰 시작 후에는 가격/수용 인원 필드가 잠깁니다.",
    openapi_extra={"x-agent-hint": "Organizer-only. PATCH SeatTierUpdate. Price/capacity fields locked after bidding starts (BIDDING_OPEN+)."},
)
async def update_tier(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    data: SeatTierUpdate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Update a seat tier. Organizer only."""
    # Verify event belongs to organizer
    event_result = await db.execute(
        select(Event).where(Event.id == event_id, Event.organizer_id == user.id)
    )
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    result = await db.execute(
        select(SeatTier).where(SeatTier.id == tier_id, SeatTier.event_id == event_id)
    )
    tier = result.scalar_one_or_none()
    if not tier:
        raise HTTPException(status_code=404, detail="Tier not found")

    update_data = data.model_dump(exclude_unset=True)

    # Guard: lock price/capacity fields once bidding has started
    locked_fields = {"base_price", "capacity", "face_price", "min_price", "max_price_cap"}
    if event.status in (
        EventStatus.BIDDING_OPEN,
        EventStatus.BIDDING_CLOSED,
        EventStatus.ALLOCATED,
        EventStatus.ALLOCATING,
    ):
        blocked = locked_fields & set(update_data.keys())
        if blocked:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot modify {', '.join(blocked)} after bidding has started",
            )

    # Phase E.2: 가격 변동 전 이전 값 스냅샷 (PriceAlert 훅용)
    old_face_price = float(tier.face_price) if tier.face_price is not None else None
    old_base_price = float(tier.base_price) if tier.base_price is not None else None

    for field, value in update_data.items():
        setattr(tier, field, value)

    await db.commit()
    await db.refresh(tier)

    # Phase E.2: 가격 인하 감지 → PriceAlert 발송
    price_fields_changed = {"face_price", "base_price"} & set(update_data.keys())
    if price_fields_changed:
        try:
            new_face = float(tier.face_price) if tier.face_price is not None else None
            price_dropped = (
                (new_face is not None and old_face_price is not None and new_face < old_face_price)
            )
            if price_dropped and new_face is not None:
                from app.repositories.notification_repo import PriceAlertRepository
                from app.services.push_service import send_notification

                alerts = await PriceAlertRepository(db).get_untriggered_by_tier(tier.id)
                for alert in alerts:
                    if new_face <= float(alert.target_price):
                        await send_notification(
                            session=db,
                            user_id=alert.user_id,
                            category="PRICE_DROP",
                            title="가격 알림",
                            body=f"{event.title} · {tier.name} 가격이 목표가 이하로 떨어졌어요",
                            data={
                                "event_id": str(event.id),
                                "tier_id": str(tier.id),
                                "new_price": new_face,
                                "target_price": float(alert.target_price),
                            },
                            event_id=event.id,
                            tier_id=tier.id,
                        )
                        alert.triggered = True
                await db.commit()
        except Exception:  # noqa: BLE001
            logger.warning("PriceAlert hook failed", exc_info=True)

    resp = SeatTierResponse.model_validate(tier)
    resp.remaining = tier.capacity - tier.sold_count
    return resp
