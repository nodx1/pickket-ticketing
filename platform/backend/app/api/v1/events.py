import hashlib
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select, func, and_, or_, update, case
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db, get_read_db
from app.core.errors import api_error, client_error_detail, ErrorCode
from app.core.redis import cache_get_json, cache_set_json, cache_get_or_fetch, cache_delete, cache_delete_many, cache_delete_pattern
from app.middleware.auth import (
    get_current_user,
    get_current_user_optional,
    get_current_organizer,
    get_current_admin,
)
from app.models.event import Event, EventStatus, SeatTier
from app.models.event_mirror import EventParticipant, EventAnnouncement, EventFacility
from app.models.ticket import Ticket
from app.models.lottery import LotteryEntry, LotteryEntryResult, LotteryPool
from app.models.venue import Venue
from app.models.order import Order, OrderStatus
from app.models.user import User
from app.models.interaction import UserInteraction, InteractionType
from app.schemas.event import (
    EventCreate,
    EventUpdate,
    EventResponse,
    EventParticipantOut,
    EventAnnouncementOut,
    EventFacilityOut,
    EventSummaryResponse,
    EventListResponse,
    EventListItem,
    EventListItemResponse,
    EventOpenResponse,
    PriceAdviceResponse,
    CategoryCount,
    FavoriteResponse,
    TimeSlotAvailabilityItem,
    TimeSlotAvailabilityResponse,
)
from app.core.audit import write_audit_log
from app.services.recommendation import get_recommendations, get_similar_events
from app.services.price_advisor import get_price_advice
from app.services.dashboard_service import DashboardService
from app.services.payment_service import PaymentService
from app.services.refund_service import RefundService
from app.services.time_slot_service import TimeSlotService

logger = logging.getLogger(__name__)

router = APIRouter()

# TTL constants (seconds) — 목록은 5분, 상세는 3분으로 캐시하여 DB 부하 감소
_LIST_TTL = 300  # list / search / featured / trending / ranking / categories
_DETAIL_TTL = 180  # single event detail
PUBLIC_VISIBLE_STATUSES = {
    # "이벤트 살아있는" 상태 — 응모/결제/추첨/판매 중 어느 단계든 노출 유지.
    # BIDDING_CLOSED 는 2가지 의미 겸함:
    #   (1) 응모 시작 전 pre_apply  (2) 응모 마감 + 결제/대기자 승격 진행 중
    # 두 경우 모두 consumer 에 노출되어야 UX 정상.
    # CTA 버튼 라벨은 lottery-stats.phase 로 세분화 (Phase A 구현됨).
    EventStatus.APPROVED,
    EventStatus.BIDDING_OPEN,
    EventStatus.BIDDING_CLOSED,
    EventStatus.ALLOCATING,
    EventStatus.ALLOCATED,
    # COMPLETED/CANCELLED 는 종결 상태 — 목록 숨김.
    # DRAFT/PENDING_REVIEW/UNDER_REVIEW/REVISION_REQUESTED 도 당연히 숨김.
}


def _marketplace_only():
    """Consumer 노출 조건: sale_channels 에 'marketplace' 포함.

    go에서 주최자가 토글 off 한 이벤트(['self'])는 v2 consumer 에 숨김.
    SQLite(테스트 환경)에선 JSON 타입이라 ARRAY 연산자 동작 안 함 → always-true.
    """
    import os
    from sqlalchemy import literal

    # pytest 환경(SQLite)에선 PG ARRAY contains() 가 컴파일 에러 → 필터 스킵
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return literal(True)
    return Event.sale_channels.contains(["marketplace"])


async def _invalidate_event_caches(event_id: uuid.UUID | None = None) -> None:
    """Invalidate event caches: exact keys via DEL, variable keys via parallel SCAN."""
    import asyncio

    # Exact keys — single DEL call (O(1) per key)
    exact_keys = ["events:categories", "events:featured", "events:trending", "events:opening_soon"]
    if event_id is not None:
        exact_keys.append(f"events:detail:{event_id}")
    await cache_delete_many(exact_keys)

    # Variable-key patterns — parallel SCAN.
    # events:slug:* 는 by-slug 티저(/e/[slug]) 응답 캐시(180s). event_id→slug 역참조가 없어
    # 대상 슬러그를 특정할 수 없으므로 전 슬러그 캐시를 무효화한다(이미지/카테고리/갤러리
    # go→v2 PATCH 전파 후 by-slug 표면이 최대 TTL 동안 stale 로 남던 갭 보정).
    patterns = ["events:list:*", "events:search:*", "events:ranking:*", "events:public_list:*", "events:public_report:*", "events:slug:*"]
    if event_id is not None:
        patterns.extend([
            f"events:transparency:{event_id}:*",
            f"events:similar:{event_id}",
            # 🔴 티어 목록 캐시가 무효화 대상에서 **빠져 있었다** (2026-08-02).
            #    티어를 숨김/비활성으로 바꿔도 최대 TTL(300초) 동안 옛 값이 공개
            #    엔드포인트로 나갔다. 숨기는 조치가 5분 늦게 먹는다는 뜻이다.
            f"tiers:list:v2:{event_id}",
            f"tiers:list:{event_id}",  # 옛 키 — 배포 후 잔존분 정리
        ])
    await asyncio.gather(*(cache_delete_pattern(p) for p in patterns))


def _utcnow():
    """Return current UTC time as a naive datetime for DB comparison compatibility."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _ensure_naive(dt: datetime) -> datetime:
    """Strip timezone info if present, for consistent comparison with SQLite."""
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _can_view_event(event: Event, user: User | None) -> bool:
    # sale_channels 에 marketplace 없으면 non-admin/non-organizer 는 미노출.
    # legacy/테스트 호환: None 이거나 empty 면 기본 [self, marketplace] 간주.
    sale_channels = getattr(event, "sale_channels", None)
    if not sale_channels:
        sale_channels = ["self", "marketplace"]
    is_marketplace = "marketplace" in sale_channels
    if event.status in PUBLIC_VISIBLE_STATUSES and is_marketplace:
        return True
    if user is None:
        return False
    if user.is_admin:
        return True
    return event.organizer_id == user.id


def _ensure_event_visible(event: Event, user: User | None) -> None:
    if not _can_view_event(event, user):
        raise api_error(ErrorCode.EVENT_NOT_FOUND)


def public_seat_tier_ids(event: Event) -> set[str]:
    """공개해도 되는 티어 id 집합 — **한 곳에서만 판정한다**.

    🔴 왜 헬퍼인가 (2026-08-02):
       공개 상세(`get_event`)에만 필터를 넣었더니, **같은 `EventResponse.seat_tiers`
       를 직렬화하는 다른 4곳**(`/events/{id}/sessions`·`/public-events`·
       `/transparency`·`/me/favorites`)이 그대로 숨김 티어의 id·가격·정원을 흘렸다.
       적대 검증이 실증했다. 복붙하면 **다음에 또 빠진다** — 판정을 한 곳에 둔다.

    ⚠️ **응답 dict 의 `visibility` 로 거르지 말 것.** `SeatTierResponse`·
       `SeatTierResponseCompact` 둘 다 그 필드를 내보내지 않아, `.get(..., "public")`
       이 항상 기본값을 돌려주고 필터가 전부 통과한다(실측). ORM 에서 판정하고
       **id 로** 거른다 — 응답에 없는 값으로 응답을 거를 수는 없다.
    """
    return {
        str(t.id)
        for t in (getattr(event, "seat_tiers", None) or [])
        if str(getattr(t, "visibility", "public")).lower() == "public"
        and bool(getattr(t, "is_active", True))
    }


def strip_hidden_seat_tiers(payload, event: Event):
    """공개 응답에서 숨김·비활성 티어를 제거한다(제자리 수정 후 반환).

    dict(=`model_dump` 결과)와 Pydantic 응답 객체를 **둘 다** 받는다. 호출부마다
    형태가 달라서(`/events/{id}` 는 dict, `/sessions`·`/me/favorites` 는 객체) 한쪽만
    지원하면 결국 복붙이 생긴다.

    ⚠️ **캐시에 넣기 전에** 부르십시오. 순서가 계약입니다 — 필터가 뒤면 캐시에
       걸러지지 않은 값이 들어가고 TTL 동안 그대로 나갑니다.
    """
    allowed = public_seat_tier_ids(event)
    if isinstance(payload, dict):
        if isinstance(payload.get("seat_tiers"), list):
            payload["seat_tiers"] = [
                t for t in payload["seat_tiers"] if str(t.get("id")) in allowed
            ]
        return payload
    tiers = getattr(payload, "seat_tiers", None)
    if isinstance(tiers, list):
        payload.seat_tiers = [t for t in tiers if str(getattr(t, "id", "")) in allowed]
    return payload


async def _cancel_event_orders_and_refund(
    db: AsyncSession,
    *,
    event_id: uuid.UUID,
    reason: str,
) -> dict:
    refund_service = RefundService(db)
    payment_service = PaymentService(db)
    refunded = 0
    cancelled = 0
    failed = 0

    # Process orders in bounded batches (keyset pagination by id) so an event
    # with tens of thousands of orders never loads them all into memory.
    BATCH_SIZE = 200
    last_id: uuid.UUID | None = None
    while True:
        batch_query = (
            select(Order)
            .where(Order.event_id == event_id)
            .order_by(Order.id)
            .limit(BATCH_SIZE)
        )
        if last_id is not None:
            batch_query = batch_query.where(Order.id > last_id)

        result = await db.execute(batch_query)
        orders = list(result.scalars().all())
        if not orders:
            break

        for order in orders:
            last_id = order.id
            try:
                # SAVEPOINT per order: a flush failure inside one order's refund/
                # cancel must NOT poison the session — otherwise the next batch's
                # db.execute() raises InvalidRequestError and silently aborts ALL
                # remaining orders.
                async with db.begin_nested():
                    if order.status in (OrderStatus.CONFIRMED, OrderStatus.PAID):
                        await refund_service.request_refund(
                            order.id,
                            reason=reason,
                            initiated_by="system",
                            force_auto_approve=True,
                        )
                        refunded += 1
                    elif order.status in (
                        OrderStatus.PENDING,
                        OrderStatus.PAYMENT_REQUIRED,
                        OrderStatus.AUTHORIZED,
                    ):
                        await payment_service.cancel_order(order.id, target_status=OrderStatus.CANCELLED)
                        cancelled += 1
            except Exception as exc:  # noqa: BLE001
                failed += 1
                logger.warning(
                    "Event cancellation order handling failed (event=%s, order=%s): %s",
                    event_id,
                    order.id,
                    exc,
                )

        if len(orders) < BATCH_SIZE:
            break

    return {"refunded": refunded, "cancelled": cancelled, "failed": failed}


# ---------------------------------------------------------------------------
# New endpoints — MUST be defined BEFORE /{event_id} catch-all
# ---------------------------------------------------------------------------


@router.get(
    "/search",
    response_model=EventListItemResponse,
    summary="이벤트 검색",
    description="키워드, 카테고리, 도시, 날짜 범위 등 다양한 필터로 이벤트를 검색합니다. 결과는 페이지네이션됩니다.",
    openapi_extra={"x-agent-hint": "Full-text search with filters: q (keyword), category, sub_category, city, date_from, date_to, status. Returns paginated EventListItemResponse."},
)
async def search_events(
    q: str | None = Query(None, max_length=200),
    category: str | None = None,
    sub_category: str | None = None,
    city: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    price_min: float | None = None,
    price_max: float | None = None,
    event_status: str | None = Query(None, alias="status"),
    is_public_sector: bool | None = None,
    sort: str = "newest",
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_read_db),
):
    """Search events with various filters and sorting."""
    # --- cache read ---
    raw = f"{q}:{category}:{sub_category}:{city}:{date_from}:{date_to}:{price_min}:{price_max}:{event_status}:{is_public_sector}:{sort}:{skip}:{limit}"
    h = hashlib.md5(raw.encode(), usedforsecurity=False).hexdigest()[:12]
    cache_key = f"events:search:{h}"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        logger.debug("Cache HIT: %s", cache_key)
        return cached
    logger.debug("Cache MISS: %s", cache_key)

    conditions = []
    conditions.append(Event.status.in_(list(PUBLIC_VISIBLE_STATUSES)))
    conditions.append(_marketplace_only())

    if q:
        # PostgreSQL: GIN 인덱스(idx_event_fts) 활용 — O(log N)
        # SQLite (테스트): LIKE 폴백
        dialect_name = db.bind.dialect.name if db.bind else "postgresql"
        if dialect_name == "postgresql":
            ts_query = func.plainto_tsquery("simple", q)
            ts_vector = func.to_tsvector(
                "simple",
                func.coalesce(Event.title, "")
                + " "
                + func.coalesce(Event.description, "")
                + " "
                + func.coalesce(Event.venue, "")
                + " "
                + func.coalesce(Event.artist_name, ""),
            )
            conditions.append(ts_vector.op("@@")(ts_query))
        else:
            q_lower = f"%{q.lower()}%"
            conditions.append(
                or_(
                    func.lower(Event.title).like(q_lower),
                    func.lower(Event.description).like(q_lower),
                    func.lower(Event.venue).like(q_lower),
                    func.lower(Event.artist_name).like(q_lower),
                )
            )

    if category:
        conditions.append(Event.category == category.lower())

    if sub_category:
        conditions.append(Event.sub_category == sub_category)

    if city:
        conditions.append(Event.location_city == city)

    if date_from:
        conditions.append(Event.event_date >= date_from)

    if date_to:
        conditions.append(Event.event_date <= date_to)

    if price_min is not None:
        conditions.append(Event.min_price >= price_min)

    if price_max is not None:
        conditions.append(Event.min_price <= price_max)

    if event_status:
        conditions.append(Event.status == EventStatus(event_status))

    if is_public_sector is not None:
        conditions.append(Event.is_public_sector == is_public_sector)

    # Count
    count_query = select(func.count(Event.id))
    if conditions:
        count_query = count_query.where(and_(*conditions))
    count_result = await db.execute(count_query)
    total = count_result.scalar()

    # Sort
    query = select(Event)
    if conditions:
        query = query.where(and_(*conditions))

    if sort == "popular":
        query = query.order_by(Event.bid_count.desc())
    elif sort == "price_asc":
        query = query.order_by(Event.min_price.asc())
    elif sort == "price_desc":
        query = query.order_by(Event.min_price.desc())
    elif sort == "date":
        query = query.order_by(Event.event_date.asc())
    else:  # newest
        query = query.order_by(Event.created_at.desc())

    query = (
        query.options(
            selectinload(Event.organizer),
            selectinload(Event.seat_tiers),
        )
        .offset(skip)
        .limit(limit)
    )
    result = await db.execute(query)
    events = result.scalars().all()

    response = EventListItemResponse(
        events=[EventListItem.model_validate(e) for e in events], total=total
    )

    # --- cache write ---
    await cache_set_json(cache_key, response.model_dump(mode="json"), ttl=_LIST_TTL)
    return response


@router.get(
    "/featured",
    response_model=list[EventListItem],
    summary="추천 이벤트 목록",
    description="관리자가 선정한 추천(featured) 이벤트를 최대 5개 반환합니다.",
    openapi_extra={"x-agent-hint": "No parameters needed. Returns up to 5 featured events. Cached 5 min."},
)
async def featured_events(db: AsyncSession = Depends(get_read_db)):
    """Get featured events (is_featured=True), limit 5."""

    async def _fetch():
        result = await db.execute(
            select(Event)
            .where(
                Event.is_featured.is_(True),
                Event.status.notin_([EventStatus.DRAFT, EventStatus.PENDING_REVIEW, EventStatus.UNDER_REVIEW, EventStatus.CANCELLED]),
                _marketplace_only(),
            )
            .options(selectinload(Event.organizer), selectinload(Event.seat_tiers))
            .order_by(Event.created_at.desc())
            .limit(5)
        )
        events = result.scalars().all()
        return [EventListItem.model_validate(e).model_dump(mode="json") for e in events]

    return await cache_get_or_fetch("events:featured", _fetch, ttl=_LIST_TTL)


@router.get(
    "/trending",
    response_model=list[EventListItem],
    summary="인기 이벤트 목록",
    description="입찰 수(bid_count) 기준 인기 이벤트를 최대 10개 반환합니다.",
    openapi_extra={"x-agent-hint": "No parameters needed. Returns up to 10 trending events sorted by bid_count DESC. Cached 5 min."},
)
async def trending_events(db: AsyncSession = Depends(get_read_db)):
    """Get trending events by bid_count DESC where status is active, limit 10."""

    async def _fetch():
        result = await db.execute(
            select(Event)
            .where(Event.status.in_([EventStatus.BIDDING_OPEN, EventStatus.APPROVED, EventStatus.ALLOCATED]))
            .where(_marketplace_only())
            .options(selectinload(Event.organizer), selectinload(Event.seat_tiers))
            .order_by(Event.bid_count.desc())
            .limit(10)
        )
        events = result.scalars().all()
        return [EventListItem.model_validate(e).model_dump(mode="json") for e in events]

    return await cache_get_or_fetch("events:trending", _fetch, ttl=_LIST_TTL)


@router.get("/opening-soon", response_model=list[EventSummaryResponse])
async def opening_soon_events(db: AsyncSession = Depends(get_read_db)):
    """Get events opening soon: bidding_opens_at > now, ordered by bidding_opens_at ASC, limit 20."""
    # --- cache read ---
    cache_key = "events:opening_soon"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        logger.debug("Cache HIT: %s", cache_key)
        return cached
    logger.debug("Cache MISS: %s", cache_key)

    now = _utcnow()
    result = await db.execute(
        select(Event)
        .where(Event.bidding_opens_at > now)
        .where(Event.status.in_(list(PUBLIC_VISIBLE_STATUSES)))
        .where(_marketplace_only())
        .options(selectinload(Event.seat_tiers), selectinload(Event.organizer))
        .order_by(Event.bidding_opens_at.asc())
        .limit(20)
    )
    events = result.scalars().all()
    response = [EventSummaryResponse.model_validate(e).model_dump(mode="json") for e in events]

    # --- cache write ---
    await cache_set_json(cache_key, response, ttl=_LIST_TTL)
    return response


@router.get("/ranking", response_model=list[EventSummaryResponse])
async def event_ranking(
    period: str = "realtime",
    category: str | None = None,
    db: AsyncSession = Depends(get_read_db),
):
    """Event ranking based on bid_count."""
    # --- cache read ---
    cache_key = f"events:ranking:{period}:{category}"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        logger.debug("Cache HIT: %s", cache_key)
        return cached
    logger.debug("Cache MISS: %s", cache_key)

    conditions = []
    if category:
        conditions.append(Event.category == category.lower())

    query = select(Event).where(Event.status.in_(list(PUBLIC_VISIBLE_STATUSES))).where(_marketplace_only())
    if conditions:
        query = query.where(and_(*conditions))

    query = (
        query.options(
            selectinload(Event.seat_tiers),
            selectinload(Event.organizer),
        )
        .order_by(Event.bid_count.desc())
        .limit(20)
    )
    result = await db.execute(query)
    events = result.scalars().all()
    response = [EventSummaryResponse.model_validate(e).model_dump(mode="json") for e in events]

    # --- cache write ---
    await cache_set_json(cache_key, response, ttl=_LIST_TTL)
    return response


@router.get("/categories", response_model=list[CategoryCount])
async def event_categories(db: AsyncSession = Depends(get_read_db)):
    """Returns category aggregation: [{category: "CONCERT", count: 42}, ...]"""
    # --- cache read ---
    cache_key = "events:categories"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        logger.debug("Cache HIT: %s", cache_key)
        return cached
    logger.debug("Cache MISS: %s", cache_key)

    result = await db.execute(
        select(Event.category, func.count(Event.id).label("count"))
        .where(Event.status.in_(list(PUBLIC_VISIBLE_STATUSES)))
        .where(_marketplace_only())
        .group_by(Event.category)
        .order_by(func.count(Event.id).desc())
    )
    rows = result.all()
    response = [
        CategoryCount(category=row[0], count=row[1]).model_dump(mode="json") for row in rows
    ]

    # --- cache write ---
    await cache_set_json(cache_key, response, ttl=_LIST_TTL)
    return response


@router.get("/{event_id}/availability", response_model=TimeSlotAvailabilityResponse)
async def get_event_availability(
    event_id: uuid.UUID,
    date: str = Query(..., description="YYYY-MM-DD"),
    tier_id: uuid.UUID | None = Query(None),
    db: AsyncSession = Depends(get_read_db),
):
    """Return time-slot availability for a specific event date."""
    try:
        target_date = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="date must be in YYYY-MM-DD format",
        ) from exc

    service = TimeSlotService(db)
    try:
        slots = await service.get_daily_availability(event_id, target_date, tier_id=tier_id)
    except ValueError as exc:
        logger.warning("Time slot availability lookup failed for event %s", event_id, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=client_error_detail(exc, "시간대 조회에 실패했습니다."),
        ) from exc

    return TimeSlotAvailabilityResponse(
        slots=[
            TimeSlotAvailabilityItem(
                start=slot.start_time,
                end=slot.end_time,
                available=slot.available,
                total=slot.capacity,
            )
            for slot in slots
        ]
    )


@router.get("/{event_id}/tiers/remaining")
async def get_tiers_remaining(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_read_db),
):
    """실시간 잔여석 — Redis 직접 조회, DB 미접근. p99 < 5ms."""
    from app.services import inventory_service
    from app.models.event import SeatTier

    # 🔴 **공개 엔드포인트다** (2026-08-02). 종전엔 두 가지가 빠져 있었다:
    #      ① 행사 가시성 검사가 없어 `{self}` 전용 행사의 티어도 200 으로 나갔다
    #      ② 티어 필터가 없어 **숨김 초대권의 id·정원·잔여가 무인증으로 샜다**
    #    응답의 **키가 티어 id** 라 그 자체가 유출이다. 지금은 그 id 로 도달할 결제
    #    경로가 없지만(go checkout·게스트·직접구매 모두 차단됨), 노출을 방어선으로
    #    삼지 않는다 — 문 하나가 새로 열리면 그때 바로 뚫린다.
    event = (await db.execute(select(Event).where(Event.id == event_id))).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    _ensure_event_visible(event, None)

    # 🔴 캐시 키를 바꾼다. 옛 키(`tiers:list:`)에는 **숨김 티어가 이미 들어 있고**
    #    TTL 이 300초라, 필터만 넣으면 그동안 오염된 값이 그대로 나간다.
    cache_key = f"tiers:list:v2:{event_id}"
    cached = await cache_get_json(cache_key)
    if cached:
        tiers_info = cached
    else:
        result = await db.execute(
            select(SeatTier.id, SeatTier.name, SeatTier.capacity, SeatTier.sold_count)
            .where(
                SeatTier.event_id == event_id,
                SeatTier.visibility == "public",
                SeatTier.is_active.is_(True),
            )
        )
        rows = result.all()
        tiers_info = [
            {"id": str(r.id), "name": r.name, "capacity": r.capacity, "sold_count": r.sold_count}
            for r in rows
        ]
        await cache_set_json(cache_key, tiers_info, ttl=300)

    # Redis에서 실시간 잔여석 조회 — 단일 파이프라인으로 N+1 round-trip 제거
    remaining_values: list[int] = []
    try:
        from app.core.redis import get_redis
        _redis = get_redis()
        pipe = _redis.pipeline()
        for tier in tiers_info:
            pipe.get(f"{inventory_service.KEY_PREFIX}:{tier['id']}")
        raw_results = await pipe.execute()
        remaining_values = [int(v) if v is not None else -1 for v in raw_results]
    except Exception:
        # Redis unavailable → fall back to DB-derived remaining for every tier
        remaining_values = [-1] * len(tiers_info)

    remaining_map = {}
    for tier, remaining in zip(tiers_info, remaining_values):
        remaining_map[tier["id"]] = {
            "name": tier["name"],
            "capacity": tier["capacity"],
            "remaining": remaining if remaining >= 0 else tier["capacity"] - tier["sold_count"],
            "source": "redis" if remaining >= 0 else "db_fallback",
        }

    return remaining_map


@router.get("/recommended", response_model=list[EventSummaryResponse])
async def recommended_events(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Personalized recommendations (requires auth)."""
    events = await get_recommendations(user.id, db, limit=10)
    return [EventSummaryResponse.model_validate(e) for e in events]


@router.get("/favorites", response_model=list[EventSummaryResponse])
async def list_favorites(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List user's favorited events (requires auth).

    Uses a window function (ROW_NUMBER) to get the latest interaction per
    event_id in a single query, then filters where type='FAVORITE'.
    """
    # Subquery: latest interaction per event_id using ROW_NUMBER window function
    latest_interaction = (
        select(
            UserInteraction.event_id,
            UserInteraction.interaction_type,
            func.row_number()
            .over(
                partition_by=UserInteraction.event_id,
                order_by=UserInteraction.created_at.desc(),
            )
            .label("rn"),
        )
        .where(
            UserInteraction.user_id == user.id,
            UserInteraction.interaction_type.in_([
                InteractionType.FAVORITE.value,
                InteractionType.UNFAVORITE.value,
            ]),
        )
        .subquery()
    )

    fav_ids_result = await db.execute(
        select(latest_interaction.c.event_id)
        .where(latest_interaction.c.rn == 1)
        .where(latest_interaction.c.interaction_type == InteractionType.FAVORITE.value)
    )
    fav_event_ids = [r[0] for r in fav_ids_result.all()]

    if not fav_event_ids:
        return []

    result = await db.execute(
        select(Event)
        .where(Event.id.in_(fav_event_ids))
        .options(selectinload(Event.seat_tiers), selectinload(Event.organizer))
    )
    events = result.scalars().all()
    return [EventSummaryResponse.model_validate(e) for e in events]


# ---------------------------------------------------------------------------
# Existing endpoints
# ---------------------------------------------------------------------------


@router.post(
    "/",
    response_model=EventResponse,
    status_code=status.HTTP_201_CREATED,
    summary="이벤트 생성",
    description="새로운 이벤트를 생성합니다. 주최자 권한이 필요합니다. EventCreate 스키마에 따라 제목, 날짜, 장소, 카테고리 등을 설정합니다.",
    openapi_extra={"x-agent-hint": "Organizer-only. POST EventCreate body with title, category, venue_id, dates, pricing. Returns full EventResponse."},
)
async def create_event(
    data: EventCreate,
    request: Request,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    # Venue 자동 연결: venue_id가 명시되면 검증 후 사용, 아니면 이름으로 매칭
    resolved_venue_id = data.venue_id
    if resolved_venue_id:
        venue_exists = await db.execute(
            select(Venue.id).where(Venue.id == resolved_venue_id)
        )
        if not venue_exists.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="존재하지 않는 장소(venue_id)입니다")
    elif data.venue:
        venue_match = await db.execute(
            select(Venue).where(func.lower(Venue.name) == data.venue.lower().strip())
        )
        matched = venue_match.scalar_one_or_none()
        if matched:
            resolved_venue_id = matched.id

    # Auto-generate slug if not provided
    import re
    slug = data.slug
    if not slug:
        base = re.sub(r"[^a-zA-Z0-9가-힣]+", "-", data.title.strip()).lower()[:60].strip("-")
        slug = f"{base}-{uuid.uuid4().hex[:8]}"
    # Ensure uniqueness
    existing = await db.execute(select(Event.id).where(Event.slug == slug))
    if existing.scalar_one_or_none():
        slug = f"{slug}-{uuid.uuid4().hex[:6]}"

    normalized_category = (data.category or "concert").lower()

    event = Event(
        organizer_id=user.id,
        title=data.title,
        slug=slug,
        description=data.description,
        venue=data.venue,
        venue_id=resolved_venue_id,
        event_date=data.event_date,
        bidding_opens_at=data.bidding_opens_at,
        bidding_closes_at=data.bidding_closes_at,
        total_seats=data.total_seats,
        min_price=data.min_price,
        max_price=data.max_price,
        # Extended fields
        category=normalized_category,
        sub_category=data.sub_category,
        image_url=data.image_url,
        thumbnail_url=data.thumbnail_url,
        location_city=data.location_city,
        artist_name=data.artist_name,
        age_restriction=data.age_restriction,
        tags=data.tags,
        is_featured=False,  # admin-only: set via admin endpoint
        duration_minutes=data.duration_minutes,
        # Public sector
        is_public_sector=data.is_public_sector,
        is_free=data.is_free,
        require_checkin=data.require_checkin,
        locality_restricted=data.locality_restricted,
        deposit_amount=data.deposit_amount,
        no_show_policy=data.no_show_policy,
        cancellation_fee_tiers=data.cancellation_fee_tiers,
        discount_policies=data.discount_policies,
        resident_priority=data.resident_priority,
        resident_priority_days=data.resident_priority_days,
        nft_enabled=data.nft_enabled,
        # Regulation
        price_cap_multiplier=data.price_cap_multiplier,
        require_identity_verification=data.require_identity_verification,
        # Remainder
        remainder_strategy=data.remainder_strategy,
        remainder_trigger_hours=data.remainder_trigger_hours,
        remainder_step_interval_min=data.remainder_step_interval_min,
        # Multi-session
        multi_max_wins_per_user=data.multi_max_wins_per_user,
        multi_loser_bonus_weight=data.multi_loser_bonus_weight,
        multi_cross_session_dedup=data.multi_cross_session_dedup,
        # Resale
        resale_enabled=data.resale_enabled,
        resale_max_markup_pct=data.resale_max_markup_pct,
        resale_royalty_pct=data.resale_royalty_pct,
        resale_opens_at=data.resale_opens_at,
        resale_closes_at=data.resale_closes_at,
        # Organizer portal fields
        age_rating=data.age_rating,
        seat_type=data.seat_type,
        seat_map_url=data.seat_map_url,
        allocation_ratio=data.allocation_ratio,
        delivery_method=data.delivery_method,
        mobile_ticket_enabled=data.mobile_ticket_enabled,
        ticket_display_info=data.ticket_display_info,
        desired_open_date=data.desired_open_date,
        notice=data.notice,
        description_images=data.description_images,
        participant_enabled=data.participant_enabled,
        board_types=data.board_types,
        event_date_end=data.event_date_end,
        # Content fields
        program_notes=data.program_notes,
        program_data=data.program_data,
        stage_info=data.stage_info,
        time_slot_enabled=data.time_slot_enabled,
        time_slot_capacity=data.time_slot_capacity,
        time_slot_duration_minutes=data.time_slot_duration_minutes,
        # Sports fields
        home_team=data.home_team,
        away_team=data.away_team,
        match_status=data.match_status,
        broadcast_url=data.broadcast_url,
        broadcast_platform=data.broadcast_platform,
        parking_info=data.parking_info,
        # Globalization
        currency=data.currency,
        event_timezone=data.event_timezone,
        # Missing model fields
        subject_name=data.subject_name,
        season_ticket_enabled=data.season_ticket_enabled,
        home_away_section=data.home_away_section,
        resale_surplus_recapture_pct=data.resale_surplus_recapture_pct,
        # DICE+Laylo DNA
        brand_color=data.brand_color,
        brand_color_fg=data.brand_color_fg,
        service_fee_rate=data.service_fee_rate,
    )
    db.add(event)
    await db.flush()

    await write_audit_log(
        db,
        actor_id=user.id,
        action="event.create",
        resource_type="event",
        resource_id=str(event.id),
        new_value={"title": data.title, "category": normalized_category, "total_seats": data.total_seats},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    await db.commit()

    # Re-fetch with relationships loaded to avoid MissingGreenlet on lazy access
    result = await db.execute(
        select(Event)
        .where(Event.id == event.id)
        .options(selectinload(Event.seat_tiers), selectinload(Event.organizer))
    )
    event = result.scalar_one()

    # --- cache invalidation ---
    await _invalidate_event_caches()

    return EventResponse.model_validate(event)


@router.get(
    "/",
    response_model=EventListItemResponse,
    summary="이벤트 목록 조회",
    description="공개 이벤트 목록을 페이지네이션으로 조회합니다. category, status, sort 필터를 지원합니다.",
    openapi_extra={"x-agent-hint": "Use filters: category, status, skip, limit (max 100), sort. Returns paginated list with total count."},
)
async def list_events(
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    category: str | None = Query(None, max_length=50),
    event_status: EventStatus | None = Query(None, alias="status"),
    db: AsyncSession = Depends(get_read_db),
):
    # --- cache read ---
    cache_key = (
        f"events:list:{skip}:{limit}:{category}:{event_status.value if event_status else ''}"
    )
    cached = await cache_get_json(cache_key)
    if cached is not None:
        logger.debug("Cache HIT: %s", cache_key)
        return cached
    logger.debug("Cache MISS: %s", cache_key)

    conditions = [Event.status.in_(list(PUBLIC_VISIBLE_STATUSES)), _marketplace_only()]
    if category:
        conditions.append(Event.category == category.lower())
    if event_status is not None:
        conditions.append(Event.status == event_status)

    count_query = select(func.count(Event.id))
    if conditions:
        count_query = count_query.where(and_(*conditions))
    count_result = await db.execute(count_query)
    total = count_result.scalar()

    query = (
        select(Event)
        .options(selectinload(Event.organizer), selectinload(Event.seat_tiers))
        .order_by(Event.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    if conditions:
        query = query.where(and_(*conditions))

    result = await db.execute(query)
    events = result.scalars().all()
    response = EventListItemResponse(
        events=[EventListItem.model_validate(e) for e in events], total=total
    )

    # --- cache write ---
    await cache_set_json(cache_key, response.model_dump(mode="json"), ttl=_LIST_TTL)
    return response


# ---------------------------------------------------------------------------
# Per-event endpoints with path params — MUST come AFTER named routes
# ---------------------------------------------------------------------------


@router.get("/{event_id}/transparency")
async def transparency_report(
    event_id: uuid.UUID,
    tier_id: uuid.UUID | None = Query(None),
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Public transparency report for an event (anonymized).

    Returns anonymized data including participant bands, total sold,
    allocation method, and price statistics. No personal data included.
    """
    result = await db.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if not event:
        raise api_error(ErrorCode.EVENT_NOT_FOUND)
    _ensure_event_visible(event, user)

    cache_key = f"events:transparency:{event_id}:{tier_id}"
    if event.status in PUBLIC_VISIBLE_STATUSES:
        cached = await cache_get_json(cache_key)
        if cached is not None:
            logger.debug("Cache HIT: %s", cache_key)
            return cached
        logger.debug("Cache MISS: %s", cache_key)

    try:
        service = DashboardService(db)
        report = await service.get_transparency_report(
            event_id=event_id,
            tier_id=tier_id,
        )
    except ValueError as e:
        logger.warning("Transparency report lookup failed for event %s", event_id, exc_info=True)
        raise api_error(
            ErrorCode.EVENT_NOT_FOUND,
            client_error_detail(e, "이벤트를 찾을 수 없습니다."),
        )

    # --- cache write ---
    if event.status in PUBLIC_VISIBLE_STATUSES:
        await cache_set_json(cache_key, report, ttl=_LIST_TTL)
    return report


@router.get("/{event_id}/similar", response_model=list[EventSummaryResponse])
async def similar_events(
    event_id: uuid.UUID,
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Content-based similar events, limit 4."""
    result = await db.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if not event:
        raise api_error(ErrorCode.EVENT_NOT_FOUND)
    _ensure_event_visible(event, user)

    cache_key = f"events:similar:{event_id}"
    if event.status in PUBLIC_VISIBLE_STATUSES:
        cached = await cache_get_json(cache_key)
        if cached is not None:
            logger.debug("Cache HIT: %s", cache_key)
            return cached
        logger.debug("Cache MISS: %s", cache_key)

    events = await get_similar_events(event_id, db, limit=4)
    response = [EventSummaryResponse.model_validate(e).model_dump(mode="json") for e in events]

    # --- cache write ---
    if event.status in PUBLIC_VISIBLE_STATUSES:
        await cache_set_json(cache_key, response, ttl=_LIST_TTL)
    return response


@router.get("/{event_id}/price-advice", response_model=PriceAdviceResponse)
async def price_advice(
    event_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """AI price advisor (requires auth)."""
    try:
        advice = await get_price_advice(event_id, user.id, db)
    except ValueError as e:
        logger.warning("Price advice lookup failed for event %s", event_id, exc_info=True)
        raise api_error(
            ErrorCode.EVENT_NOT_FOUND,
            client_error_detail(e, "이벤트를 찾을 수 없습니다."),
        )
    return PriceAdviceResponse(**advice)


@router.post("/{event_id}/view", status_code=status.HTTP_200_OK)
async def record_view(
    event_id: uuid.UUID,
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Record a view and increment view_count (fire-and-forget optimized)."""
    # Single UPDATE with RETURNING — no SELECT or REFRESH needed
    result = await db.execute(
        update(Event)
        .where(Event.id == event_id)
        .values(view_count=Event.view_count + 1)
        .returning(Event.view_count)
    )
    row = result.first()
    if not row:
        raise api_error(ErrorCode.EVENT_NOT_FOUND)
    await db.commit()

    return {"event_id": str(event_id), "view_count": row[0]}


@router.post("/{event_id}/favorite", response_model=FavoriteResponse)
async def toggle_favorite(
    event_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Toggle favorite on an event (requires auth)."""
    # Check event exists
    result = await db.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if not event:
        raise api_error(ErrorCode.EVENT_NOT_FOUND)
    _ensure_event_visible(event, user)

    # Check current favorite state — single query with CASE WHEN (net favorite
    # = #FAVORITE - #UNFAVORITE), mirroring check_favorite.
    net_result = await db.execute(
        select(
            func.coalesce(
                func.sum(
                    case(
                        (UserInteraction.interaction_type == InteractionType.FAVORITE.value, 1),
                        (UserInteraction.interaction_type == InteractionType.UNFAVORITE.value, -1),
                        else_=0,
                    )
                ),
                0,
            )
        ).where(
            UserInteraction.user_id == user.id,
            UserInteraction.event_id == event_id,
            UserInteraction.interaction_type.in_([
                InteractionType.FAVORITE.value,
                InteractionType.UNFAVORITE.value,
            ]),
        )
    )
    is_currently_fav = (net_result.scalar() or 0) > 0

    if is_currently_fav:
        # Unfavorite
        interaction = UserInteraction(
            user_id=user.id,
            event_id=event_id,
            interaction_type=InteractionType.UNFAVORITE.value,
        )
        db.add(interaction)
        await db.commit()
        return FavoriteResponse(event_id=event_id, is_favorited=False)
    else:
        # Favorite
        interaction = UserInteraction(
            user_id=user.id,
            event_id=event_id,
            interaction_type=InteractionType.FAVORITE.value,
        )
        db.add(interaction)
        await db.commit()
        return FavoriteResponse(event_id=event_id, is_favorited=True)


@router.get("/{event_id}/favorite/check", response_model=FavoriteResponse)
async def check_favorite(
    event_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Check if user has favorited an event (single query)."""
    result = await db.execute(
        select(
            func.coalesce(
                func.sum(
                    case(
                        (UserInteraction.interaction_type == InteractionType.FAVORITE.value, 1),
                        (UserInteraction.interaction_type == InteractionType.UNFAVORITE.value, -1),
                        else_=0,
                    )
                ),
                0,
            )
        ).where(
            UserInteraction.user_id == user.id,
            UserInteraction.event_id == event_id,
            UserInteraction.interaction_type.in_([
                InteractionType.FAVORITE.value,
                InteractionType.UNFAVORITE.value,
            ]),
        )
    )
    net_fav = result.scalar()
    return FavoriteResponse(event_id=event_id, is_favorited=net_fav > 0)


@router.get(
    "/by-slug/{slug}",
    response_model=EventOpenResponse,
    summary="슬러그로 이벤트 오픈 페이지 조회",
    description="/e/<slug> 랜딩 페이지용 경량 응답. 카운트다운, 브랜드 컬러, 구독자 수 포함.",
    openapi_extra={"x-agent-hint": "Used by /e/<slug> landing pages. Returns EventOpenResponse with countdown anchor (ticket_open_at = desired_open_date)."},
)
async def get_event_by_slug(
    slug: str,
    db: AsyncSession = Depends(get_read_db),
):
    cache_key = f"events:slug:{slug}"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        return cached

    result = await db.execute(
        select(Event)
        .where(Event.slug == slug, Event.status.in_([s.value for s in PUBLIC_VISIBLE_STATUSES]))
        .where(_marketplace_only())
    )
    event = result.scalars().first()
    if not event:
        raise api_error(ErrorCode.EVENT_NOT_FOUND)

    # Count open subscribers (A2에서 테이블 생성 후 실제 카운트로 교체)
    subscriber_count = 0
    try:
        from app.models.event_open_subscription import EventOpenSubscription
        sub_result = await db.execute(
            select(func.count(EventOpenSubscription.id))
            .where(EventOpenSubscription.event_id == event.id)
        )
        subscriber_count = sub_result.scalar() or 0
    except Exception:
        pass  # 테이블 미존재 시 0 반환

    resp = EventOpenResponse(
        id=event.id,
        slug=event.slug,
        title=event.title,
        venue=event.venue,
        venue_id=event.venue_id,
        image_url=event.image_url,
        image_variants=event.image_variants,
        gallery_images=event.gallery_images,
        thumbnail_url=event.thumbnail_url,
        event_date=event.event_date,
        ticket_open_at=event.desired_open_date,
        brand_color=event.brand_color,
        brand_color_fg=event.brand_color_fg,
        category=event.category,
        artist_name=event.artist_name,
        location_city=event.location_city,
        status=event.status.value,
        service_fee_rate=float(event.service_fee_rate),
        subscriber_count=subscriber_count,
    )
    await cache_set_json(cache_key, resp.model_dump(mode="json"), ttl=_DETAIL_TTL)
    return resp


@router.get(
    "/{event_id}",
    response_model=EventResponse,
    summary="이벤트 상세 조회",
    description="이벤트 ID로 상세 정보를 조회합니다. 공개 상태이면 인증 없이 조회 가능하며, DRAFT 상태는 주최자/관리자만 볼 수 있습니다.",
    openapi_extra={"x-agent-hint": "Pass event_id as UUID path param. Public events need no auth. Returns full EventResponse with tiers, venue, organizer info."},
)
async def get_event(
    event_id: uuid.UUID,
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_read_db),
):
    # Check cache BEFORE DB query for public (non-auth) requests
    cache_key = f"events:detail:{event_id}"
    if user is None:
        cached = await cache_get_json(cache_key)
        if cached is not None:
            logger.debug("Cache HIT: %s", cache_key)
            return cached
        logger.debug("Cache MISS: %s", cache_key)

    result = await db.execute(
        select(Event)
        .where(Event.id == event_id)
        .options(selectinload(Event.seat_tiers), selectinload(Event.organizer))
    )
    event = result.scalars().first()
    if not event:
        raise api_error(ErrorCode.EVENT_NOT_FOUND)

    # 자동 상태 전환: approved → bidding_open / bidding_open → bidding_closed
    now = datetime.now(timezone.utc)
    new_status = None

    def _ensure_aware(dt: datetime) -> datetime:
        return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt

    if (
        event.status == EventStatus.APPROVED
        and event.bidding_opens_at
        and _ensure_aware(event.bidding_opens_at) <= now
    ):
        new_status = EventStatus.BIDDING_OPEN
    elif (
        event.status == EventStatus.BIDDING_OPEN
        and event.bidding_closes_at
        and _ensure_aware(event.bidding_closes_at) <= now
    ):
        new_status = EventStatus.BIDDING_CLOSED
    if new_status:
        # Best-effort, fire-and-forget. This is a hot READ path — never block
        # the response on a write, and only let ONE concurrent request open a
        # write session via a short Redis NX lock so the write pool isn't
        # exhausted under load. If we can't acquire the lock (another request
        # is already transitioning) we simply skip and serve the read; the next
        # request after the transition commits will observe the new status.
        try:
            from app.core.redis import get_redis
            _redis = get_redis()
            _lock_key = f"v2:evt_transition:{event_id}"
            _acquired = await _redis.set(_lock_key, "1", nx=True, ex=10)
        except Exception:
            _acquired = False

        if _acquired:
            try:
                from app.core.database import async_session
                async with async_session() as write_db:
                    from sqlalchemy import update
                    await write_db.execute(
                        update(Event).where(Event.id == event_id).values(status=new_status)
                    )
                    await write_db.commit()
                event.status = new_status
                await cache_delete(cache_key)
            except Exception:
                pass

    _ensure_event_visible(event, user)

    # Authenticated users may still get cache if status is public
    if user is not None and event.status in PUBLIC_VISIBLE_STATUSES:
        cached = await cache_get_json(cache_key)
        if cached is not None:
            return cached

    response = EventResponse.model_validate(event).model_dump(mode="json")

    # 🔴 **공개 상세는 숨김·비활성 티어를 내보내지 않는다** (2026-08-02).
    #    종전엔 `seat_tiers` 에 hidden 초대권(0원·정원 100만)의 id·가격·정원이 그대로
    #    실려 나갔다. 지금은 그 id 로 도달할 결제 경로가 없지만(go checkout·게스트·
    #    직접구매 모두 차단), **노출을 방어선으로 삼지 않는다.**
    #
    #    ⚠️ 쿼리(`selectinload`)가 아니라 **응답 직렬화에서** 거른다. 같은 관계를
    #       주최자 대시보드·내부 경로도 쓰는데 쿼리를 바꾸면 그쪽이 티어를 잃는다.
    #
    #    ⚠️ 이 함수는 응답을 **캐시에 넣는다**(_DETAIL_TTL). 필터가 여기 있어야
    #       캐시에도 걸러진 값이 들어간다 — 순서가 계약이다.
    #
    #    🔴 **응답 dict 의 visibility 로 거르면 안 된다.** `SeatTierResponse`·
    #       `SeatTierResponseCompact` 둘 다 그 필드를 내보내지 않아서, `.get(..., "public")`
    #       이 항상 기본값을 돌려주고 필터가 전부 통과한다(실측). **ORM 객체에서**
    #       판정하고 그 id 로 거른다 — 응답에 없는 값으로 응답을 거를 수는 없다.
    strip_hidden_seat_tiers(response, event)

    # go 미러 노출 (단계5) — 출연진/공지/시설을 별도 쿼리로 주입(relationship 아님).
    parts = (await db.execute(
        select(EventParticipant)
        .where(EventParticipant.event_id == event_id)
        .order_by(EventParticipant.sort_order)
    )).scalars().all()
    anns = (await db.execute(
        select(EventAnnouncement)
        .where(EventAnnouncement.event_id == event_id)
        .order_by(EventAnnouncement.published_at.desc())
    )).scalars().all()
    facs = (await db.execute(
        select(EventFacility).where(EventFacility.event_id == event_id)
    )).scalars().all()
    response["participants"] = [
        EventParticipantOut.model_validate(p).model_dump(mode="json") for p in parts
    ]
    response["announcements"] = [
        EventAnnouncementOut.model_validate(a).model_dump(mode="json") for a in anns
    ]
    response["facilities"] = [
        EventFacilityOut.model_validate(f).model_dump(mode="json") for f in facs
    ]

    # --- cache write ---
    if event.status in PUBLIC_VISIBLE_STATUSES:
        await cache_set_json(cache_key, response, ttl=_DETAIL_TTL)
    return response


@router.patch("/{event_id}", response_model=EventResponse)
async def update_event(
    event_id: uuid.UUID,
    data: EventUpdate,
    request: Request,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Event).where(Event.id == event_id, Event.organizer_id == user.id)
    )
    event = result.scalar_one_or_none()
    if not event:
        raise api_error(ErrorCode.EVENT_NOT_FOUND)

    update_data = data.model_dump(exclude_unset=True)

    # is_featured는 스키마에서 제거됨 — admin 전용 엔드포인트에서만 설정 가능

    # Restrict editable fields based on event status
    # event_date 포함 — 판매 개시 후 일정 변경은 기판매 티켓의 관람 조건을 사후 변경하는 사고
    restricted_fields = {"total_seats", "min_price", "max_price", "category", "venue", "event_date"}
    always_editable = {
        "description",
        "image_url",
        "thumbnail_url",
        "tags",
        "artist_name",
        "age_restriction",
    }

    if event.status in (EventStatus.BIDDING_OPEN, EventStatus.BIDDING_CLOSED):
        blocked = restricted_fields & set(update_data.keys())
        if blocked:
            raise api_error(
                ErrorCode.EVENT_NOT_MODIFIABLE,
                f"Cannot modify {', '.join(blocked)} after bidding has started",
            )
    elif event.status in (EventStatus.ALLOCATED, EventStatus.ALLOCATING):
        allowed = always_editable
        disallowed = set(update_data.keys()) - allowed
        if disallowed:
            raise api_error(
                ErrorCode.EVENT_NOT_MODIFIABLE,
                f"Cannot modify {', '.join(disallowed)} after allocation",
            )

    # Validate venue_id if provided
    if "venue_id" in update_data and update_data["venue_id"] is not None:
        venue_exists = await db.execute(
            select(Venue.id).where(Venue.id == update_data["venue_id"])
        )
        if not venue_exists.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="존재하지 않는 장소(venue_id)입니다")

    for field, value in update_data.items():
        setattr(event, field, value)

    await write_audit_log(
        db,
        actor_id=user.id,
        action="event.update",
        resource_type="event",
        resource_id=str(event_id),
        new_value=update_data,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    await db.commit()

    # Re-fetch with relationships loaded to avoid MissingGreenlet on lazy access
    result = await db.execute(
        select(Event)
        .where(Event.id == event_id)
        .options(selectinload(Event.seat_tiers), selectinload(Event.organizer))
    )
    event = result.scalar_one()

    # --- cache invalidation ---
    await _invalidate_event_caches(event_id)

    return EventResponse.model_validate(event)


@router.delete("/{event_id}", status_code=status.HTTP_200_OK)
async def delete_event(
    event_id: uuid.UUID,
    request: Request,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Delete or cancel an event. Only organizer who owns the event."""
    result = await db.execute(
        select(Event).where(Event.id == event_id, Event.organizer_id == user.id)
    )
    event = result.scalar_one_or_none()
    if not event:
        raise api_error(ErrorCode.EVENT_NOT_FOUND)

    if event.status == EventStatus.DRAFT:
        # Hard delete draft events (no bids possible)
        tiers_result = await db.execute(select(SeatTier).where(SeatTier.event_id == event_id))
        for tier in tiers_result.scalars().all():
            await db.delete(tier)
        await write_audit_log(
            db,
            actor_id=user.id,
            action="event.delete",
            resource_type="event",
            resource_id=str(event_id),
            old_value={"title": event.title, "status": "draft"},
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent", "")[:500],
        )
        await db.delete(event)
        await db.commit()
        # --- cache invalidation ---
        await _invalidate_event_caches(event_id)
        return {"message": "Event deleted"}

    if event.status in (EventStatus.BIDDING_OPEN, EventStatus.BIDDING_CLOSED):
        # Soft-delete: set status to CANCELLED
        old_status = event.status.value if hasattr(event.status, "value") else str(event.status)
        event.status = EventStatus.CANCELLED
        order_summary = await _cancel_event_orders_and_refund(
            db,
            event_id=event_id,
            reason="event_cancelled_by_organizer",
        )
        # 추첨 풀/응모 정리: 미추첨 풀 CLOSED 전이(자동 추첨 차단) + 응모자 투자 AP 환급
        from app.services.lottery_service import LotteryService

        lottery_summary = await LotteryService(db).cancel_pools_for_event(event_id)
        await write_audit_log(
            db,
            actor_id=user.id,
            action="event.cancel",
            resource_type="event",
            resource_id=str(event_id),
            old_value={"status": old_status},
            new_value={
                "status": "cancelled",
                "orders": order_summary,
                "lottery": lottery_summary,
            },
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent", "")[:500],
        )
        await db.commit()
        # --- cache invalidation ---
        await _invalidate_event_caches(event_id)
        return {
            "message": "Event cancelled",
            "orders": order_summary,
            "lottery": lottery_summary,
        }

    raise api_error(
        ErrorCode.EVENT_NOT_DELETABLE,
        "Cannot delete an event that has already been allocated or completed",
    )


# ---------------------------------------------------------------------------
# Event Review Workflow
# ---------------------------------------------------------------------------


@router.post("/{event_id}/submit-review")
async def submit_event_for_review(
    event_id: uuid.UUID,
    request: Request,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Submit an event for admin review (DRAFT/REVISION_REQUESTED → PENDING_REVIEW)."""
    from app.services.event_review_service import EventReviewService

    svc = EventReviewService(db)
    try:
        event = await svc.submit_for_review(event_id, user.id)
    except ValueError as e:
        logger.warning("Submit review failed for event %s", event_id, exc_info=True)
        raise HTTPException(
            status_code=400,
            detail=client_error_detail(e, "이벤트 검토 요청에 실패했습니다."),
        )
    await write_audit_log(
        db,
        actor_id=user.id,
        action="event.submit_review",
        resource_type="event",
        resource_id=str(event_id),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    await db.commit()
    await _invalidate_event_caches(event_id)

    # Re-fetch with relationships loaded to avoid MissingGreenlet
    result = await db.execute(
        select(Event)
        .where(Event.id == event_id)
        .options(selectinload(Event.seat_tiers), selectinload(Event.organizer))
    )
    event = result.scalar_one()

    return EventResponse.model_validate(event)


@router.post("/{event_id}/convert-to-fcfs")
async def convert_to_fcfs(
    event_id: uuid.UUID,
    tier_id: uuid.UUID | None = None,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin: 추첨 tier를 선착순으로 수동 전환."""
    if tier_id:
        tier = await db.execute(
            select(SeatTier).where(SeatTier.id == tier_id, SeatTier.event_id == event_id)
        )
        t = tier.scalar_one_or_none()
        if not t:
            raise api_error(ErrorCode.EVENT_NOT_FOUND, "Tier not found")
        t.sale_mode = "fixed_fcfs"
    else:
        await db.execute(
            update(SeatTier)
            .where(SeatTier.event_id == event_id, SeatTier.sale_mode == "point_lottery")
            .values(sale_mode="fixed_fcfs")
        )

    event = await db.execute(select(Event).where(Event.id == event_id))
    ev = event.scalar_one_or_none()
    if ev:
        # EventStatus enum에 OPEN 멤버 없음(F9). fcfs 재오픈 목표상태 = BIDDING_OPEN.
        # (tier.sale_mode=fixed_fcfs 이므로 추첨 apply 대신 일반 구매만 허용됨)
        ev.status = EventStatus.BIDDING_OPEN
        # 잔여 선착순 종료 시각 = 공연 당일. 기존 bidding_closes_at(추첨 마감)이
        # 이미 과거면 즉시 구매 차단되므로 event_date 로 연장(phase_transition·payment_expiry 정책 동일).
        if ev.event_date and (ev.bidding_closes_at is None or ev.bidding_closes_at < ev.event_date):
            ev.bidding_closes_at = ev.event_date
    await db.commit()
    await _invalidate_event_caches(event_id)
    return {
        "ok": True,
        "event_id": str(event_id),
        "status": EventStatus.BIDDING_OPEN.value,
        "sale_mode": "fixed_fcfs",
    }


@router.patch("/{event_id}/admin-review")
async def admin_review_event(
    event_id: uuid.UUID,
    request: Request,
    action: str = Query(description="approve / reject / revision_requested / start_review"),
    comment: str | None = None,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin: review an event (approve/reject/request revision/start review)."""
    from app.services.event_review_service import EventReviewService

    svc = EventReviewService(db)
    try:
        if action == "approve":
            event = await svc.approve(event_id, admin.id)
        elif action == "reject":
            event = await svc.reject(event_id, admin.id)
        elif action == "revision_requested":
            event = await svc.request_revision(event_id, admin.id, comment)
        elif action == "start_review":
            event = await svc.start_review(event_id, admin.id)
        else:
            raise HTTPException(status_code=400, detail=f"Invalid action: {action}")
    except ValueError as e:
        logger.warning("Admin review action '%s' failed for event %s", action, event_id, exc_info=True)
        raise HTTPException(
            status_code=400,
            detail=client_error_detail(e, "이벤트 검토 처리에 실패했습니다."),
        )
    await write_audit_log(
        db,
        actor_id=admin.id,
        action=f"event.admin_review.{action}",
        resource_type="event",
        resource_id=str(event_id),
        new_value={"action": action, "comment": comment},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    await db.commit()
    await _invalidate_event_caches(event_id)

    # go 로 심사 결과 webhook 발송 (approve / reject 시)
    if action in ("approve", "reject"):
        from app.services.go_review_webhook import send_review_result

        go_action = "approved" if action == "approve" else "rejected"
        await send_review_result(
            event_id=event_id,
            action=go_action,
            reviewer_id=admin.id,
            reason=comment,
        )

    # Re-fetch with relationships loaded to avoid MissingGreenlet
    result = await db.execute(
        select(Event)
        .where(Event.id == event_id)
        .options(selectinload(Event.seat_tiers), selectinload(Event.organizer))
    )
    event = result.scalar_one()

    return EventResponse.model_validate(event)


# ─── User participation status ──────────────────────────────────────────────


@router.get("/{event_id}/my-status")
async def get_my_event_status(
    event_id: uuid.UUID,
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Check if the current user has purchased or applied for this event."""
    # 비로그인 → 빈 상태 반환
    empty = {
        "has_ticket": False,
        "ticket_count": 0,
        "has_lottery_entry": False,
        "lottery_status": None,
        "lottery_entry_id": None,
        "invested_ap": 0,
        "lottery_tier_id": None,
        "lottery_pool_id": None,
        "lottery_group_size": 1,
    }
    if not user:
        return empty

    # 1. Check purchased tickets — PENDING(결제 대기)은 제외.
    # 당첨 미결제자가 "예매 완료" 로 잘못 판정되어 재구매 차단되는 버그 방지.
    # PENDING 은 결제 만료되면 cancelled 되므로 "확정된" ticket 만 true.
    from app.models.ticket import TicketStatus as _TicketStatus
    ticket_result = await db.execute(
        select(Ticket.id, Ticket.status).where(
            Ticket.event_id == event_id,
            Ticket.current_owner_id == user.id,
            Ticket.status.in_([_TicketStatus.ACTIVE, _TicketStatus.USED]),
        )
    )
    tickets = ticket_result.all()

    # 2. Check lottery entries (with pool + tier info)
    entry_result = await db.execute(
        select(
            LotteryEntry.id,
            LotteryEntry.result,
            LotteryEntry.invested_ap,
            LotteryEntry.group_size,
            LotteryPool.id.label("pool_id"),
            LotteryPool.tier_id,
        ).join(
            LotteryPool, LotteryEntry.pool_id == LotteryPool.id
        ).where(
            LotteryPool.event_id == event_id,
            LotteryEntry.user_id == user.id,
        )
    )
    entries = entry_result.all()

    result = {
        "has_ticket": len(tickets) > 0,
        "ticket_count": len(tickets),
        "has_lottery_entry": len(entries) > 0,
        "lottery_status": entries[0].result.value if entries else None,
        "lottery_entry_id": str(entries[0].id) if entries else None,
        "invested_ap": entries[0].invested_ap if entries else 0,
        "lottery_tier_id": str(entries[0].tier_id) if entries else None,
        "lottery_pool_id": str(entries[0].pool_id) if entries else None,
        "lottery_group_size": entries[0].group_size if entries else 1,
        "lottery_order_id": None,
        "lottery_payment_deadline": None,
        "lottery_order_status": None,
        # waitlisted 인 경우 같은 pool 내 FIFO 순번 (1-based)
        "lottery_waitlist_position": None,
    }

    # waitlisted 인 경우 순번 계산 (같은 pool 내 created_at ASC)
    if entries and entries[0].result == LotteryEntryResult.WAITLISTED:
        from sqlalchemy import func as _sql_func
        my_created_at = entries[0].created_at
        my_pool_id = entries[0].pool_id
        earlier_count_row = await db.execute(
            select(_sql_func.count(LotteryEntry.id)).where(
                LotteryEntry.pool_id == my_pool_id,
                LotteryEntry.result == LotteryEntryResult.WAITLISTED,
                LotteryEntry.created_at < my_created_at,
            )
        )
        earlier_count = earlier_count_row.scalar() or 0
        result["lottery_waitlist_position"] = int(earlier_count) + 1

    # 당첨자인 경우 order 정보 추가 — 만료/취소 포함 (frontend 가 결제 만료자 분기에 사용)
    if entries and entries[0].result.value == "won":
        from app.models.order import Order
        order_q = await db.execute(
            select(Order.id, Order.status, Order.payment_deadline, Order.total_amount).where(
                Order.event_id == event_id,
                Order.user_id == user.id,
            ).order_by(Order.created_at.desc()).limit(1)
        )
        order = order_q.first()
        if order:
            result["lottery_order_id"] = str(order.id)
            result["lottery_payment_deadline"] = order.payment_deadline.isoformat() if order.payment_deadline else None
            result["lottery_order_status"] = order.status.value

    return result
