import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, status
from sqlalchemy import select, func, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.errors import api_error, ErrorCode
from app.middleware.auth import get_current_user
from app.middleware.metrics import ACTIVE_BIDS
from app.models.event import Event, EventStatus
from app.models.bid import Bid, BidStatus
from app.models.user import User
from app.schemas.bid import BidCreate, BidUpdate, BidResponse, BidStatusResponse
from app.api.v1.deps import verify_behavior_token

logger = logging.getLogger(__name__)


def _utcnow():
    """Return current UTC time as a naive datetime for DB comparison compatibility."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _ensure_naive(dt: datetime) -> datetime:
    """Strip timezone info if present, for consistent comparison with SQLite."""
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


router = APIRouter()


@router.post(
    "/{event_id}/bids",
    response_model=BidResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_behavior_token)],
    summary="입찰 생성",
    description="이벤트에 새로운 입찰을 등록합니다. 입찰 기간 내에만 가능하며, 최대 지불 의사 금액(max_willingness_to_pay)과 수량을 지정합니다. 중복 입찰은 불가합니다.",
    openapi_extra={"x-agent-hint": "Auth required. POST BidCreate with max_willingness_to_pay, quantity. Check bidding window (bidding_opens_at ~ bidding_closes_at). One active bid per user per event."},
)
async def create_bid(
    event_id: uuid.UUID,
    data: BidCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Check event exists and is open for bidding
    result = await db.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if not event:
        raise api_error(ErrorCode.EVENT_NOT_FOUND)

    # go "paused"(주최자 판매 일시중지) — 응모도 차단. 재개 시 직전 상태 그대로.
    if getattr(event, "sales_paused", False) is True:
        raise api_error(ErrorCode.EVENT_NOT_OPEN, "Sales are temporarily paused")

    now = _utcnow()
    if now < _ensure_naive(event.bidding_opens_at):
        raise api_error(ErrorCode.BID_WINDOW_CLOSED, "Bidding has not started yet")
    if now > _ensure_naive(event.bidding_closes_at):
        raise api_error(ErrorCode.BID_WINDOW_CLOSED, "Bidding has closed")
    if event.status not in (EventStatus.DRAFT, EventStatus.APPROVED, EventStatus.BIDDING_OPEN):
        raise api_error(ErrorCode.EVENT_NOT_OPEN, "Event is not accepting bids")

    # Validate price bounds
    if event.min_price > 0 and data.max_willingness_to_pay < event.min_price:
        raise api_error(ErrorCode.BID_EXCEEDS_LIMIT, f"Bid must be at least {event.min_price}")
    if event.max_price and data.max_willingness_to_pay > event.max_price:
        raise api_error(ErrorCode.BID_EXCEEDS_LIMIT, f"Bid cannot exceed {event.max_price}")

    # Check duplicate bid
    existing = await db.execute(
        select(Bid).where(
            Bid.user_id == user.id,
            Bid.event_id == event_id,
            Bid.status == BidStatus.ACTIVE,
        )
    )
    if existing.scalar_one_or_none():
        raise api_error(
            ErrorCode.BID_ALREADY_EXISTS,
            "You already have an active bid for this event",
            status_code=400,
        )

    bid = Bid(
        user_id=user.id,
        event_id=event_id,
        max_willingness_to_pay=data.max_willingness_to_pay,
        quantity=data.quantity,
    )
    db.add(bid)

    # Auto-update event status if first bid + increment bid count atomically
    status_changed = event.status in (EventStatus.DRAFT, EventStatus.APPROVED)
    update_values: dict = {"bid_count": Event.bid_count + 1}
    if status_changed:
        update_values["status"] = EventStatus.BIDDING_OPEN
    await db.execute(
        update(Event).where(Event.id == event_id).values(**update_values)
    )

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise api_error(
            ErrorCode.BID_ALREADY_EXISTS,
            "You already have an active bid for this event",
            status_code=400,
        )

    # Invalidate event caches when status changed
    if status_changed:
        from app.api.v1.events import _invalidate_event_caches
        await _invalidate_event_caches(event_id)
    await db.refresh(bid)
    try:
        ACTIVE_BIDS.inc()
    except Exception:
        logger.debug("Failed to record ACTIVE_BIDS.inc metric")
    return BidResponse.model_validate(bid)


@router.get(
    "/{event_id}/bids/status",
    response_model=BidStatusResponse,
    summary="입찰 현황 조회",
    description="이벤트의 전체 입찰 참여자 수, 입찰 마감 시간, 현재 입찰 가능 여부, 내 입찰 정보를 반환합니다.",
    openapi_extra={"x-agent-hint": "Auth required. Returns total_participants, bidding_closes_at, is_open flag, and my_bid if exists."},
)
async def get_bid_status(
    event_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if not event:
        raise api_error(ErrorCode.EVENT_NOT_FOUND)

    count_result = await db.execute(
        select(func.count(Bid.id)).where(Bid.event_id == event_id, Bid.status == BidStatus.ACTIVE)
    )
    total_participants = count_result.scalar()

    my_bid_result = await db.execute(
        select(Bid).where(
            Bid.user_id == user.id,
            Bid.event_id == event_id,
            Bid.status == BidStatus.ACTIVE,
        )
    )
    my_bid = my_bid_result.scalar_one_or_none()

    now = _utcnow()
    return BidStatusResponse(
        total_participants=total_participants,
        bidding_closes_at=event.bidding_closes_at,
        is_open=_ensure_naive(event.bidding_opens_at)
        <= now
        <= _ensure_naive(event.bidding_closes_at),
        my_bid=BidResponse.model_validate(my_bid) if my_bid else None,
    )


@router.patch(
    "/{event_id}/bids/{bid_id}",
    response_model=BidResponse,
    summary="입찰 수정",
    description="입찰 기간 내에 기존 입찰의 금액 또는 수량을 수정합니다. 본인의 활성 입찰만 수정 가능합니다.",
    openapi_extra={"x-agent-hint": "Auth required. PATCH BidUpdate with optional max_willingness_to_pay, quantity. Only owner can update. Must be within bidding window."},
)
async def update_bid(
    event_id: uuid.UUID,
    bid_id: uuid.UUID,
    data: BidUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Bid).where(
            Bid.id == bid_id,
            Bid.user_id == user.id,
            Bid.event_id == event_id,
            Bid.status == BidStatus.ACTIVE,
        )
    )
    bid = result.scalar_one_or_none()
    if not bid:
        raise api_error(ErrorCode.BID_NOT_FOUND)

    # Check bidding window still open
    event_result = await db.execute(select(Event).where(Event.id == event_id))
    event = event_result.scalar_one_or_none()
    now = _utcnow()
    if now > _ensure_naive(event.bidding_closes_at):
        raise api_error(ErrorCode.BID_WINDOW_CLOSED, "Bidding has closed")

    # idx12: 수정 경로도 생성과 동일한 가격 상·하한 정책을 적용한다.
    # (이전엔 누락 — PATCH 로 max_price 상한을 우회해 배분 우선순위 조작 가능했음)
    if data.max_willingness_to_pay is not None:
        if event.min_price and event.min_price > 0 and data.max_willingness_to_pay < event.min_price:
            raise api_error(
                ErrorCode.BID_EXCEEDS_LIMIT, f"Bid must be at least {event.min_price}"
            )
        if event.max_price and data.max_willingness_to_pay > event.max_price:
            raise api_error(
                ErrorCode.BID_EXCEEDS_LIMIT, f"Bid cannot exceed {event.max_price}"
            )
        bid.max_willingness_to_pay = data.max_willingness_to_pay
    if data.quantity is not None:
        bid.quantity = data.quantity

    await db.commit()
    await db.refresh(bid)
    return BidResponse.model_validate(bid)


@router.delete(
    "/{event_id}/bids/{bid_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="입찰 취소",
    description="본인의 활성 입찰을 취소합니다. 취소 후 재입찰 가능합니다.",
    openapi_extra={"x-agent-hint": "Auth required. Cancels the user's active bid. Bid status changes to CANCELLED."},
)
async def cancel_bid(
    event_id: uuid.UUID,
    bid_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Bid).where(
            Bid.id == bid_id,
            Bid.user_id == user.id,
            Bid.event_id == event_id,
            Bid.status == BidStatus.ACTIVE,
        )
    )
    bid = result.scalar_one_or_none()
    if not bid:
        raise api_error(ErrorCode.BID_NOT_FOUND)

    bid.status = BidStatus.CANCELLED

    # Decrement bid count atomically
    await db.execute(
        update(Event)
        .where(Event.id == event_id, Event.bid_count > 0)
        .values(bid_count=Event.bid_count - 1)
    )

    await db.commit()
    try:
        ACTIVE_BIDS.dec()
    except Exception:
        logger.debug("Failed to record ACTIVE_BIDS.dec metric")
