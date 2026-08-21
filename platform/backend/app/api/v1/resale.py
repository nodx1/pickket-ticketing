"""Resale marketplace endpoints."""

import logging
import uuid
import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db, read_session_factory
from app.core.redis import get_redis
from app.core.sse import (
    SSEConnection,
    format_heartbeat,
    format_sse,
    get_last_event_id,
)
from app.middleware.auth import get_current_user
from app.models.user import User
from app.schemas.resale import (
    ResaleListingCreate,
    ResaleListingResponse,
    ResaleBuyOrderCreate,
    ResaleBuyOrderResponse,
    ResaleMarketResponse,
    TradingDataResponse,
    PriceCandle,
    ResaleListingBrowseResponse,
)
from app.core.audit import write_audit_log
from app.core.config import settings
from app.core.errors import ErrorCode, api_error, client_error_detail
from app.core.feature_gate import ensure_resale_enabled
from app.middleware.rate_limit import rate_limit_general
from app.services.resale_service import ResaleService

logger = logging.getLogger(__name__)
router = APIRouter(dependencies=[Depends(ensure_resale_enabled)])
MARKET_STREAM_INTERVAL_SECONDS = 5
MARKET_SNAPSHOT_TTL_SECONDS = 5
SSE_MAX_PER_MARKET = 200


async def _load_trading_snapshot(event_id: uuid.UUID, tier_id: uuid.UUID) -> str:
    async with read_session_factory() as db:
        service = ResaleService(db)
        data = await service.get_trading_data(event_id, tier_id)
        return data.model_dump_json()


def _to_text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="ignore")
    return str(value)


async def _get_trading_snapshot_cached(event_id: uuid.UUID, tier_id: uuid.UUID) -> str:
    cache_key = f"v2:resale:trading:{event_id}:{tier_id}"
    refresh_lock_key = f"{cache_key}:refresh"
    try:
        redis = get_redis()
    except RuntimeError:
        return await _load_trading_snapshot(event_id, tier_id)

    cached = await redis.get(cache_key)
    if cached:
        return _to_text(cached)

    acquired = await redis.set(refresh_lock_key, "1", nx=True, ex=MARKET_SNAPSHOT_TTL_SECONDS)
    if acquired:
        payload = await _load_trading_snapshot(event_id, tier_id)
        await redis.setex(cache_key, MARKET_SNAPSHOT_TTL_SECONDS, payload)
        return payload

    await asyncio.sleep(0.05)
    cached = await redis.get(cache_key)
    if cached:
        return _to_text(cached)

    payload = await _load_trading_snapshot(event_id, tier_id)
    await redis.setex(cache_key, MARKET_SNAPSHOT_TTL_SECONDS, payload)
    return payload


# ------------------------------------------------------------------
# Fee info (public)
# ------------------------------------------------------------------


@router.get("/fee-info")
async def get_fee_info():
    """현재 리세일 수수료 정책 조회 (공개)"""
    return {
        "platform_fee_rate": settings.RESALE_PLATFORM_FEE_RATE,
        "artist_royalty_rate": settings.RESALE_ARTIST_ROYALTY_RATE,
        "seller_premium_rate": settings.RESALE_SELLER_PREMIUM_RATE,
        "zero_fee_below_face": settings.RESALE_ZERO_FEE_BELOW_FACE,
        "absolute_price_ceiling": settings.RESALE_ABSOLUTE_PRICE_CEILING,
    }


# ------------------------------------------------------------------
# Listings
# ------------------------------------------------------------------


@router.post(
    "/listings",
    response_model=ResaleListingResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_listing(
    data: ResaleListingCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a resale listing for an owned ticket.

    Validates ownership, resale eligibility, price caps, and
    computes the fee split (platform + artist royalty).
    """
    try:
        service = ResaleService(db)
        result = await service.create_listing(
            seller_id=user.id,
            ticket_id=data.ticket_id,
            asking_price=data.asking_price,
        )
        await write_audit_log(
            db,
            actor_id=user.id,
            action="resale.create_listing",
            resource_type="resale_listing",
            resource_id=str(result.id),
            new_value={"ticket_id": str(data.ticket_id), "asking_price": data.asking_price},
        )
        await db.commit()
        return result
    except PermissionError as e:
        logger.warning("Resale listing permission denied: %s", e)
        raise api_error(ErrorCode.INSUFFICIENT_PERMISSIONS, "Permission denied")
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=client_error_detail(e, "리세일 처리 중 오류가 발생했습니다"))


@router.delete(
    "/listings/{listing_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def cancel_listing(
    listing_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Cancel an active resale listing. Owner only."""
    try:
        service = ResaleService(db)
        await service.cancel_listing(seller_id=user.id, listing_id=listing_id)
        await write_audit_log(
            db,
            actor_id=user.id,
            action="resale.cancel_listing",
            resource_type="resale_listing",
            resource_id=str(listing_id),
        )
        await db.commit()
    except PermissionError as e:
        logger.warning("Resale cancel listing permission denied: %s", e)
        raise api_error(ErrorCode.INSUFFICIENT_PERMISSIONS, "Permission denied")
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=client_error_detail(e, "리세일 처리 중 오류가 발생했습니다"))


@router.get(
    "/browse",
    response_model=ResaleListingBrowseResponse,
)
async def browse_all_listings(
    category: str | None = Query(default=None),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=50),
    db: AsyncSession = Depends(get_read_db),
):
    """Browse all active resale listings across events (public).

    Optionally filter by event category (e.g., 'CONCERT', 'MUSICAL').
    Returns enriched listings with event details for the marketplace browse page.
    """
    service = ResaleService(db)
    return await service.browse_all_listings(category=category, skip=skip, limit=limit)


# ------------------------------------------------------------------
# Buy orders
# ------------------------------------------------------------------


@router.post(
    "/buy-orders",
    response_model=ResaleBuyOrderResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_buy_order(
    data: ResaleBuyOrderCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Place a buy order (bid) on the resale market."""
    try:
        service = ResaleService(db)
        result = await service.create_buy_order(
            buyer_id=user.id,
            event_id=data.event_id,
            tier_id=data.tier_id,
            max_price=data.max_price,
        )
        await write_audit_log(
            db,
            actor_id=user.id,
            action="resale.create_buy_order",
            resource_type="resale_buy_order",
            resource_id=str(result.id),
            new_value={
                "event_id": str(data.event_id),
                "tier_id": str(data.tier_id),
                "max_price": data.max_price,
            },
        )
        await db.commit()
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=client_error_detail(e, "리세일 처리 중 오류가 발생했습니다"))


@router.delete(
    "/buy-orders/{order_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def cancel_buy_order(
    order_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Cancel an active buy order. Owner only."""
    try:
        service = ResaleService(db)
        await service.cancel_buy_order(buyer_id=user.id, order_id=order_id)
        await write_audit_log(
            db,
            actor_id=user.id,
            action="resale.cancel_buy_order",
            resource_type="resale_buy_order",
            resource_id=str(order_id),
        )
        await db.commit()
    except PermissionError as e:
        logger.warning("Resale cancel buy order permission denied: %s", e)
        raise api_error(ErrorCode.INSUFFICIENT_PERMISSIONS, "Permission denied")
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=client_error_detail(e, "리세일 처리 중 오류가 발생했습니다"))


# ------------------------------------------------------------------
# Resale event discovery (public)
# ------------------------------------------------------------------


@router.get("/events")
async def resale_events(
    category: str | None = Query(default=None),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=50),
    db: AsyncSession = Depends(get_read_db),
):
    """List events with active resale listings (public)."""
    service = ResaleService(db)
    return await service.get_resale_events(category=category, skip=skip, limit=limit)


# ------------------------------------------------------------------
# Market data (public)
# ------------------------------------------------------------------


@router.get(
    "/market/{event_id}/{tier_id}",
    response_model=ResaleMarketResponse,
)
async def get_market_data(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get aggregated market data for an event/tier (public)."""
    service = ResaleService(db)
    return await service.get_market_data(event_id=event_id, tier_id=tier_id)


@router.get(
    "/listings",
    response_model=list[ResaleListingResponse],
)
async def browse_listings(
    event_id: uuid.UUID = Query(...),
    tier_id: uuid.UUID = Query(...),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Browse active resale listings for a given event/tier (public)."""
    service = ResaleService(db)
    return await service.browse_listings(event_id=event_id, tier_id=tier_id, skip=skip, limit=limit)


# ------------------------------------------------------------------
# Trading data (stock-style UI)
# ------------------------------------------------------------------


@router.get(
    "/trading/{event_id}/{tier_id}",
    response_model=TradingDataResponse,
)
async def get_trading_data(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get combined trading data: order book, trades, summary, candles."""
    service = ResaleService(db)
    return await service.get_trading_data(event_id=event_id, tier_id=tier_id)


@router.get(
    "/trading/{event_id}/{tier_id}/candles",
    response_model=list[PriceCandle],
)
async def get_price_candles(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    interval: int = Query(default=1, ge=1, le=24, description="Interval in hours"),
    limit: int = Query(default=48, ge=1, le=168),
    db: AsyncSession = Depends(get_db),
):
    """Get OHLCV price candles for charting."""
    service = ResaleService(db)
    return await service.get_price_candles(
        event_id=event_id,
        tier_id=tier_id,
        interval_hours=interval,
        limit=limit,
    )


@router.get("/stream/{event_id}/{tier_id}", dependencies=[Depends(rate_limit_general)])
async def market_stream(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    request: Request,
):
    """SSE endpoint with Redis-cached market snapshots and connection limiting."""
    redis = get_redis()
    counter_key = f"sse:count:{event_id}:{tier_id}"
    last_event_id = get_last_event_id(request)

    # Check/increment connection count
    current = await redis.incr(counter_key)
    await redis.expire(counter_key, 120)  # Auto-cleanup in 2 min

    if current > SSE_MAX_PER_MARKET:
        await redis.decr(counter_key)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Too many connections for this market",
        )

    async def event_generator():
        conn = SSEConnection(last_event_id=last_event_id)
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await _get_trading_snapshot_cached(event_id, tier_id)
                    if conn.try_consume():
                        import json as _json

                        try:
                            data = _json.loads(payload)
                        except (ValueError, TypeError):
                            data = payload
                        eid = conn.next_id()
                        conn.reset_heartbeat()
                        yield format_sse(data, event_id=eid, event_type="market_update")
                    # else: rate-limited, skip
                except Exception:
                    logger.exception(
                        "Error generating market stream snapshot for event=%s tier=%s",
                        event_id,
                        tier_id,
                    )
                    eid = conn.next_id()
                    yield format_sse({}, event_id=eid, event_type="market_update")
                await asyncio.sleep(MARKET_STREAM_INTERVAL_SECONDS)

                # Heartbeat is handled implicitly by the interval sleep,
                # but if interval is long we still send one.
                if conn.needs_heartbeat():
                    yield format_heartbeat()
        except asyncio.CancelledError:
            pass
        finally:
            # Always decrement on disconnect
            try:
                await redis.decr(counter_key)
            except Exception:
                logger.debug("redis counter decrement failed on disconnect", exc_info=True)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ------------------------------------------------------------------
# My listings / buy orders (auth required)
# ------------------------------------------------------------------


@router.get(
    "/my/listings",
    response_model=list[ResaleListingResponse],
)
async def my_listings(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List the authenticated user's resale listings."""
    service = ResaleService(db)
    listings = await service.listing_repo.get_by_seller(user.id)
    return [ResaleListingResponse.model_validate(listing) for listing in listings]


@router.get(
    "/my/buy-orders",
    response_model=list[ResaleBuyOrderResponse],
)
async def my_buy_orders(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List the authenticated user's resale buy orders."""
    service = ResaleService(db)
    orders = await service.buy_order_repo.get_by_buyer(user.id)
    return [ResaleBuyOrderResponse.model_validate(o) for o in orders]
