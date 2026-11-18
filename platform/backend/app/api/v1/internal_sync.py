"""Internal sync endpoints for pickket-go → v2 data push.

Receives seat map, tier, seat, and event data from pickket-go via webhook.
Validates HMAC signature using the shared GO_WEBHOOK_SECRET.
"""

from __future__ import annotations

import hmac
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from statistics import mean

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.config import settings
from app.core.database import async_session
from app.core.feature_flags import get_feature_flag
from app.core.http_client import traced_headers
from app.middleware.metrics import PHASE_TRANSITION_TOTAL
from app.core.webhook_verifier import verify_pickket_webhook
from app.core.redis import cache_delete_many, cache_delete_pattern, cache_set
from app.models.event import Event, EventStatus, SeatTier
from app.models.organizer import OrganizerProfile, OrganizerStatus, TrustTier
from app.models.organizer_team import OrganizerTeamMember, TeamRole
from app.models.phase_config import PhaseConfig
from app.models.event_mirror import EventParticipant, EventAnnouncement, EventFacility
from app.models.seat import Seat, SeatStatus
from app.models.user import User
from app.models.venue import Venue, VenueSection

logger = logging.getLogger(__name__)

router = APIRouter()


def _require_service_token(request: Request) -> None:
    """Authenticate an internal GET endpoint via the shared service token.

    S-1(#23): 토큰은 HMAC 서명 시크릿(GO_WEBHOOK_SECRET)과 **분리된**
    INTERNAL_SERVICE_TOKEN 을 사용한다. 평문으로 매 요청 전송되는 토큰이 서명
    시크릿과 동일하면 헤더 로그 캡처 한 번으로 HMAC 스킴 전체가 무력화되므로,
    settings.internal_service_token(전환기엔 GO_WEBHOOK_SECRET 폴백, prod 분리 강제)을 쓴다.
    이 토큰 경로는 읽기/통계 GET 전용 — write 는 _internal_auth(HMAC)가 담당한다.
    """
    token = request.headers.get("x-pickket-service-token", "")
    secret = settings.internal_service_token
    if not token or not secret or not hmac.compare_digest(token, secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid service token"
        )


# ── Schemas ──────────────────────────────────────────────────────────────


class SeatMapPayload(BaseModel):
    id: str
    name: str
    map_width: int = 1000
    map_height: int = 800
    background_url: str | None = None


class TierPayload(BaseModel):
    id: str
    name: str
    capacity: int
    base_price: float
    face_price: float
    sale_mode: str = "fixed_fcfs"
    seating_type: str = "assigned"
    color_hex: str = "#1E2A78"
    display_order: int = 0


class SeatPayload(BaseModel):
    id: str
    tier_id: str
    section: str
    row: str
    seat_number: str
    x: float = 0.0
    y: float = 0.0
    quality_score: float = 0.5
    label: str | None = None
    is_obstructed: bool = False
    # go 어드민에서 비활성화한 좌석은 status="reserved" 또는 is_active=False 로 옴.
    # 명시적 status 가 오면 그대로, 없으면 is_active=False → "reserved", 아니면 AVAILABLE.
    status: str | None = None
    is_active: bool = True


class SeatsSyncRequest(BaseModel):
    event_id: str
    venue_id: str
    seat_map: SeatMapPayload
    tiers: list[TierPayload] = Field(default_factory=list)
    seats: list[SeatPayload] = Field(default_factory=list)


class SeatsSyncResponse(BaseModel):
    ok: bool
    sections_upserted: int = 0
    tiers_upserted: int = 0
    seats_upserted: int = 0


# ── Endpoint ─────────────────────────────────────────────────────────────


@router.post(
    "/seats/sync",
    response_model=SeatsSyncResponse,
    summary="go → v2 좌석/티어 동기화",
)
async def sync_seats(request: Request):
    """pickket-go에서 좌석 배치도 데이터를 수신하여 v2 DB에 upsert."""

    raw_body = await request.body()

    # HMAC 검증
    await verify_pickket_webhook(
        request,
        raw_body,
        settings.GO_WEBHOOK_SECRET,
        source="go",
        guard_replay=True,
    )

    # Parse body (webhook verifier already validated signature)
    import json

    try:
        data = SeatsSyncRequest(**json.loads(raw_body))
    except Exception as exc:
        logger.warning("seats/sync: invalid payload: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid payload: {exc}",
        ) from exc

    event_id = uuid.UUID(data.event_id)
    venue_id = uuid.UUID(data.venue_id)

    async with async_session() as session:
        # ── 1. Venue map dimensions 업데이트 ──────────────────────────
        venue = await session.get(Venue, venue_id)
        if not venue:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Venue {data.venue_id} not found",
            )
        venue.map_width = data.seat_map.map_width
        venue.map_height = data.seat_map.map_height
        if data.seat_map.background_url:
            venue.seating_chart_url = data.seat_map.background_url

        # ── 2. Sections: venue_sections는 grid-layout/sync 전담이므로 건드리지 않음.
        # 과거엔 seats/sync도 섹션을 만들었지만 grid-layout/sync와 race condition으로
        # 중복 행이 생성되는 버그가 있어 분리. capacity는 grid-layout/sync가 figma
        # section의 rows×seatsPerRow로 계산해 보내므로 여기서 갱신할 필요 없음.
        sections_upserted = 0

        # ── 3. Tiers upsert ──────────────────────────────────────────
        tiers_upserted = 0
        for tier in data.tiers:
            tier_uuid = uuid.UUID(tier.id)
            existing_tier = await session.get(SeatTier, tier_uuid)
            if existing_tier:
                existing_tier.name = tier.name
                existing_tier.capacity = tier.capacity
                existing_tier.base_price = tier.base_price
                existing_tier.face_price = tier.face_price
                existing_tier.sale_mode = tier.sale_mode
                existing_tier.seating_type = tier.seating_type
            else:
                new_tier = SeatTier(
                    id=tier_uuid,
                    event_id=event_id,
                    name=tier.name,
                    capacity=tier.capacity,
                    base_price=tier.base_price,
                    face_price=tier.face_price,
                    sale_mode=tier.sale_mode,
                    seating_type=tier.seating_type,
                )
                session.add(new_tier)
            tiers_upserted += 1

        await session.flush()

        # ── 3.5. 기존 좌석 정리 — incoming ID 셋에 없는 좌석 삭제 ─────
        # go 가 좌석을 재생성/UUID 변경한 경우 (event_id, section, row, seat) uq 위반
        # 방지. SOLD/HELD 좌석(결제 진행/완료) 은 보호하고 다른 좌석만 정리.
        from sqlalchemy import delete as sql_delete

        incoming_seat_ids = {uuid.UUID(s.id) for s in data.seats}
        existing_seats_q = await session.execute(
            select(Seat).where(Seat.event_id == event_id)
        )
        existing_seats_all = existing_seats_q.scalars().all()
        deleted_orphans = 0
        for old_seat in existing_seats_all:
            if old_seat.id in incoming_seat_ids:
                continue
            if old_seat.status in (SeatStatus.SOLD, SeatStatus.HELD):
                continue
            await session.delete(old_seat)
            deleted_orphans += 1
        if deleted_orphans:
            await session.flush()
            logger.info(
                "seats/sync: cleaned %d orphan seats for event=%s",
                deleted_orphans, event_id,
            )

        # ── 4. Seats bulk upsert ─────────────────────────────────────
        seats_upserted = 0
        for seat in data.seats:
            seat_uuid = uuid.UUID(seat.id)
            tier_uuid = uuid.UUID(seat.tier_id)

            # row를 int로 변환 (go는 string)
            try:
                row_num = int(seat.row)
            except ValueError:
                row_num = 0

            try:
                seat_num = int(seat.seat_number)
            except ValueError:
                seat_num = 0

            # status 결정: go 명시 status 우선 → is_active=False → "reserved" → 기본 AVAILABLE.
            # 이미 SOLD/HELD 인 좌석(트랜잭션 진행 중) 은 sync 가 덮어쓰지 않음.
            if seat.status:
                try:
                    payload_status = SeatStatus(seat.status.lower())
                except ValueError:
                    payload_status = SeatStatus.AVAILABLE
            elif not seat.is_active:
                payload_status = SeatStatus.RESERVED
            else:
                payload_status = SeatStatus.AVAILABLE

            existing_seat = await session.get(Seat, seat_uuid)
            if existing_seat:
                existing_seat.tier_id = tier_uuid
                existing_seat.section = seat.section
                existing_seat.row_number = row_num
                existing_seat.seat_number = seat_num
                existing_seat.x = seat.x
                existing_seat.y = seat.y
                existing_seat.quality_score = seat.quality_score
                existing_seat.label = seat.label
                existing_seat.is_obstructed = seat.is_obstructed
                # SOLD/HELD 인 좌석은 sync 가 변경하지 않음 (결제 진행 중 보호)
                if existing_seat.status not in (SeatStatus.SOLD, SeatStatus.HELD):
                    existing_seat.status = payload_status
            else:
                new_seat = Seat(
                    id=seat_uuid,
                    event_id=event_id,
                    tier_id=tier_uuid,
                    section=seat.section,
                    row_number=row_num,
                    seat_number=seat_num,
                    x=seat.x,
                    y=seat.y,
                    quality_score=seat.quality_score,
                    label=seat.label,
                    is_obstructed=seat.is_obstructed,
                    status=payload_status,
                )
                session.add(new_seat)
            seats_upserted += 1

        # ── 5. tier.capacity 자동 재계산 — active 좌석(reserved 제외) 만 카운트 ──
        # go 어드민이 격자에서 좌석 비활성하면 그 만큼 capacity 가 줄어 진짜 판매 가능 수와 일치.
        from sqlalchemy import func as _func

        for tier in data.tiers:
            tier_uuid = uuid.UUID(tier.id)
            active_count = await session.scalar(
                select(_func.count(Seat.id)).where(
                    Seat.tier_id == tier_uuid,
                    Seat.status != SeatStatus.RESERVED,
                )
            )
            db_tier = await session.get(SeatTier, tier_uuid)
            if db_tier and active_count is not None:
                db_tier.capacity = int(active_count)

        await session.commit()

    logger.info(
        "seats/sync completed: event=%s sections=%d tiers=%d seats=%d",
        data.event_id,
        sections_upserted,
        tiers_upserted,
        seats_upserted,
    )

    return SeatsSyncResponse(
        ok=True,
        sections_upserted=sections_upserted,
        tiers_upserted=tiers_upserted,
        seats_upserted=seats_upserted,
    )


# ── Event sync: go → v2 ─────────────────────────────────────────────────────


GO_SYSTEM_USER_EMAIL = "go-system@pickket.internal"
GO_SYSTEM_USER_NAME = "pickket.go 시스템"

GO_EVENT_TYPE_TO_V2_CATEGORY: dict[str, str] = {
    "concert": "concert",
    "fan_meeting": "concert",
    "festival": "festival",
    "local_festival": "festival",
    "party": "festival",
    "conference": "education",
    "lecture": "education",
    "workshop": "education",
    "mice": "exhibition",
    "exhibition": "exhibition",
    "preview": "exhibition",
    "flea_market": "exhibition",
    "networking": "civic",
    # go EVENT_TYPES(24종) 전수 매핑 — go `domain-model.EVENT_TYPE_TO_CATEGORY` 와 같은 표.
    # 🔴 이 아래가 빠져 있어 심사 요청 때 스포츠(골프 등)·뮤지컬·세미나 행사가 「콘서트」로
    #    재분류되어 피켓 마켓에 잘못 노출됐다.
    "sports": "sports",
    "musical": "musical",
    "theater": "musical",
    "comedy": "concert",
    "awards": "concert",
    "seminar": "education",
    "webinar": "education",
    "trade_show": "exhibition",
    "screening": "exhibition",
    "meetup": "civic",
    "charity": "civic",
}

# DEPRECATED: 레거시 events/sync 경로 전용(go 미의존, grep 0건). 커머스 write 정본은
# POST/PATCH /internal/events(internal_commerce) — v2 11-상태 직접 + sales_paused 플래그.
# live→approved 로 정렬(이전 bidding_open 은 sale_window 무시·즉시판매 강제 버그).
# 'paused' 는 status가 아니라 sales_paused 플래그라 매핑에서 제외(이 경로는 미지원).
GO_STATUS_TO_V2_STATUS: dict[str, EventStatus] = {
    "draft": EventStatus.DRAFT,
    "pending_review": EventStatus.PENDING_REVIEW,
    "under_review": EventStatus.UNDER_REVIEW,
    "approved": EventStatus.APPROVED,
    "rejected": EventStatus.REVISION_REQUESTED,
    "live": EventStatus.APPROVED,  # 정렬: 판매개시 타이밍은 sale_window가 제어
    "completed": EventStatus.ALLOCATED,
    "archived": EventStatus.CANCELLED,
    "cancelled": EventStatus.CANCELLED,
    "deleted": EventStatus.CANCELLED,
}


class PhaseSchedulePayload(BaseModel):
    """go sale_phases → v2 phase_configs 매핑용.

    이게 v2의 phase SSOT. lottery-stats 는 이 테이블을 SQL 시간 비교로 읽어
    cron/webhook 없이 phase를 동적으로 결정한다.
    """
    mode: str  # membership_presale | lottery | queue_sale | fcfs_residual
    phaseOrder: int = 1
    opensAt: str
    closesAt: str


class ParticipantPayload(BaseModel):
    """go event_participants(is_visible=true) → v2 event_participants 미러."""
    name: str
    role: str | None = None
    bio: str | None = None
    imageUrl: str | None = None
    sortOrder: int = 0


class OpenNoticePayload(BaseModel):
    """go open_notices(is_published=true) → v2 event_announcements 미러."""
    type: str | None = None
    title: str
    content: str | None = None
    publishedAt: str | None = None


class FacilityPayload(BaseModel):
    """go event_facilities(내부필드 제외) → v2 event_facilities 미러."""
    name: str
    category: str | None = None
    quantity: int | None = None
    status: str | None = None


class EventSyncPayload(BaseModel):
    action: str = Field(..., description="created | updated | status_changed | deleted")
    eventId: str
    slug: str
    title: str
    summary: str | None = None
    description: str | None = None
    eventType: str
    status: str
    startsAt: str
    endsAt: str
    venueName: str | None = None
    venueAddress: str | None = None
    heroImageUrl: str | None = None
    maxAttendees: int | None = None
    isOnline: bool = False
    ageRating: str | None = None
    # go 주최자가 설정한 판매 채널: ['self'] 기본, ['self','marketplace'] 시 v2 consumer 노출
    saleChannels: list[str] | None = None
    phaseSchedules: list[PhaseSchedulePayload] = Field(default_factory=list)
    # 단계5 미러: go가 자동 첨부하는 소비자 노출 데이터(누락 시 빈 리스트 → 미러 비움)
    participants: list[ParticipantPayload] = Field(default_factory=list)
    openNotices: list[OpenNoticePayload] = Field(default_factory=list)
    facilities: list[FacilityPayload] = Field(default_factory=list)


class EventSyncResponse(BaseModel):
    ok: bool
    action: str
    eventId: str


async def _get_or_create_go_system_user(session) -> uuid.UUID:
    existing = (
        await session.execute(select(User).where(User.email == GO_SYSTEM_USER_EMAIL))
    ).scalar_one_or_none()
    if existing:
        return existing.id

    user = User(
        email=GO_SYSTEM_USER_EMAIL,
        hashed_password="!go-system-no-login!",
        name=GO_SYSTEM_USER_NAME,
    )
    session.add(user)
    await session.flush()
    return user.id


@router.post(
    "/events/sync",
    response_model=EventSyncResponse,
    summary="go → v2 이벤트 동기화",
)
async def sync_event(request: Request):
    """pickket-go에서 이벤트 데이터를 수신하여 v2 DB에 upsert."""

    raw_body = await request.body()

    await verify_pickket_webhook(
        request,
        raw_body,
        settings.GO_WEBHOOK_SECRET,
        source="go",
        guard_replay=True,
    )

    try:
        data = EventSyncPayload(**json.loads(raw_body))
    except Exception as exc:
        logger.warning("events/sync: invalid payload: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid payload: {exc}",
        ) from exc

    try:
        event_id = uuid.UUID(data.eventId)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"eventId must be a UUID: {data.eventId}",
        ) from exc

    async with async_session() as session:
        # Soft-delete (go: archived + action=deleted) — 안전을 위해 drop이 아닌 cancelled 처리
        if data.action == "deleted":
            existing = await session.get(Event, event_id)
            if existing:
                existing.status = EventStatus.CANCELLED
                await session.commit()
            return EventSyncResponse(ok=True, action=data.action, eventId=data.eventId)

        starts_at = _parse_iso(data.startsAt)
        ends_at = _parse_iso(data.endsAt)
        category = GO_EVENT_TYPE_TO_V2_CATEGORY.get(data.eventType.lower(), "concert")
        v2_status = GO_STATUS_TO_V2_STATUS.get(data.status.lower(), EventStatus.DRAFT)

        # 필수 필드 기본값 (go 페이로드에 없는 것들)
        venue_name = data.venueName or ("온라인" if data.isOnline else "장소 미정")
        bidding_opens = starts_at - timedelta(days=7)
        bidding_closes = starts_at
        total_seats = data.maxAttendees or 1000

        # venue 자동 생성/조회 (event.id = venue.id 1:1 매핑)
        venue = await session.get(Venue, event_id)
        if not venue:
            venue = Venue(
                id=event_id,
                name=venue_name,
                city="",
                address=data.venueAddress or "",
                total_capacity=total_seats,
            )
            session.add(venue)
            await session.flush()
        else:
            venue.name = venue_name
            if data.venueAddress:
                venue.address = data.venueAddress
            venue.total_capacity = total_seats

        existing = await session.get(Event, event_id)

        # saleChannels 정규화 (go 누락 시 기본 ['self'])
        sale_channels = data.saleChannels if data.saleChannels else ["self"]

        # 1) event 먼저 생성/갱신 (bidding 은 폴백값). 신규 event 는 phase_configs 보다
        #    먼저 flush 해야 FK(phase_configs.event_id → events.id) 가 충족된다.
        #    (이전 버그: phase upsert 가 event 생성 전에 실행돼 신규행사+phaseSchedules sync 가 500)
        if existing:
            target = existing
            existing.title = data.title
            existing.slug = data.slug
            existing.description = data.description or data.summary
            existing.venue = venue_name
            existing.venue_id = venue.id
            existing.event_date = starts_at
            existing.total_seats = total_seats
            existing.category = category
            existing.image_url = data.heroImageUrl
            existing.age_restriction = data.ageRating
            existing.status = v2_status
            existing.sale_channels = sale_channels
        else:
            organizer_id = await _get_or_create_go_system_user(session)
            target = Event(
                id=event_id,
                organizer_id=organizer_id,
                title=data.title,
                slug=data.slug,
                description=data.description or data.summary,
                venue=venue_name,
                venue_id=venue.id,
                event_date=starts_at,
                bidding_opens_at=bidding_opens,
                bidding_closes_at=bidding_closes,
                total_seats=total_seats,
                category=category,
                image_url=data.heroImageUrl,
                age_restriction=data.ageRating,
                status=v2_status,
                sale_channels=sale_channels,
            )
            session.add(target)
        await session.flush()  # event 영속화 → phase_configs FK 충족

        # 2) phase_configs upsert (event 존재 후 → FK OK). phase SSOT.
        ph_opens, ph_closes = await _upsert_phase_configs(
            session, event_id, data.phaseSchedules
        )
        # 3) bidding window 도출: phaseSchedules 있으면 거기서, 없으면 starts_at-7d 폴백.
        #    status_changed 액션은 시간 필드를 덮어쓰지 않음 (drift 방지).
        if data.action != "status_changed":
            target.bidding_opens_at = ph_opens if ph_opens else bidding_opens
            target.bidding_closes_at = ph_closes if ph_closes else bidding_closes

        # 4) go 미러(출연진/공지/시설) upsert — 소비자 노출 (단계5)
        await _upsert_event_mirror(
            session, event_id, data.participants, data.openNotices, data.facilities
        )

        await session.commit()

    # 메인 페이지 /trending, /featured, /search 등 Redis 캐시 즉시 무효화
    await _invalidate_event_caches(event_id)

    logger.info(
        "events/sync completed: action=%s eventId=%s status=%s category=%s",
        data.action,
        data.eventId,
        v2_status.value,
        category,
    )

    return EventSyncResponse(ok=True, action=data.action, eventId=data.eventId)


# ── Internal: lottery 자동 추첨 (go reaper 가 호출) ──────────────────────


class DrawEventLotteriesResponse(BaseModel):
    ok: bool
    eventId: str
    poolsDrawn: int
    winners: int
    waitlisted: int


@router.post(
    "/lottery/draw-event",
    response_model=DrawEventLotteriesResponse,
    summary="go reaper → v2 이벤트 전체 추첨 자동 실행",
)
async def draw_event_lotteries(request: Request):
    """이벤트의 모든 point_lottery 등급 풀을 추첨. HMAC 인증."""
    raw_body = await request.body()
    await verify_pickket_webhook(
        request,
        raw_body,
        settings.GO_WEBHOOK_SECRET,
        source="go",
        guard_replay=True,
    )

    try:
        payload = json.loads(raw_body)
        event_id = uuid.UUID(payload["eventId"])
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid payload: {exc}",
        ) from exc

    # 해당 이벤트의 point_lottery tier 들에 대해 LotteryService.draw_pool 순차 실행
    from app.services.lottery_service import LotteryService

    pools_drawn = 0
    total_winners = 0
    total_waitlisted = 0

    async with async_session() as session:
        tiers_q = await session.execute(
            select(SeatTier).where(
                SeatTier.event_id == event_id,
                SeatTier.sale_mode == "point_lottery",
            )
        )
        tiers = tiers_q.scalars().all()
        service = LotteryService(session)
        for tier in tiers:
            try:
                pool = await service.pool_repo.get_by_event_tier(event_id, tier.id)
                if pool is None:
                    continue
                result = await service.draw(pool.id)
                pools_drawn += 1
                total_winners += getattr(result, "winners", 0) or 0
                total_waitlisted += getattr(result, "waitlisted", 0) or 0
            except Exception as exc:
                logger.warning(
                    "draw-event failed for tier %s: %s", tier.id, exc
                )
        await session.commit()

    await _invalidate_event_caches(event_id)

    return DrawEventLotteriesResponse(
        ok=True,
        eventId=str(event_id),
        poolsDrawn=pools_drawn,
        winners=total_winners,
        waitlisted=total_waitlisted,
    )


@router.post(
    "/lottery/won-entries",
    summary="go recipients → v2 이벤트 당첨자 목록(알림 lotteryWon 세그먼트)",
)
async def lottery_won_entries(request: Request):
    """이벤트의 WON LotteryEntry 목록. 레벨2 P3 — go recipients.ts lotteryWon 세그먼트
    (현재 dead go bids 참조)를 v2 SoT 참조로 재작성하기 위한 additive 조회 엔드포인트.
    order_ref = 당첨자 v2 Order.external_ref(go order id) → go attendees.order_id 매칭용.
    HMAC 인증(draw-event 대칭)."""
    raw_body = await request.body()
    await verify_pickket_webhook(
        request,
        raw_body,
        settings.GO_WEBHOOK_SECRET,
        source="go",
        guard_replay=True,
    )

    try:
        payload = json.loads(raw_body)
        event_id = uuid.UUID(payload["eventId"])
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid payload: {exc}",
        ) from exc

    from app.models.lottery import LotteryEntry, LotteryEntryResult, LotteryPool
    from app.models.order import Order

    async with async_session() as session:
        rows = (
            await session.execute(
                select(LotteryEntry, LotteryPool.tier_id)
                .join(LotteryPool, LotteryPool.id == LotteryEntry.pool_id)
                .where(
                    LotteryPool.event_id == event_id,
                    LotteryEntry.result == LotteryEntryResult.WON,
                )
            )
        ).all()
        entries = []
        for entry, tier_id in rows:
            # 당첨자 order external_ref(go order id) — my-entries와 동일 조인(user+event+tier).
            order_ref = (
                await session.execute(
                    select(Order.external_ref)
                    .where(
                        Order.user_id == entry.user_id,
                        Order.event_id == event_id,
                        Order.tier_id == tier_id,
                    )
                    .order_by(Order.created_at.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            entries.append(
                {
                    "user_id": str(entry.user_id),
                    "tier_id": str(tier_id),
                    "pool_id": str(entry.pool_id),
                    "group_size": entry.group_size,
                    "order_ref": order_ref,
                }
            )

    return {"event_id": str(event_id), "entries": entries, "total": len(entries)}


async def _invalidate_event_caches(event_id: uuid.UUID | None = None) -> None:
    """events.py 의 `_invalidate_event_caches` 와 **같은** 키/패턴을 무효화한다.

    🔴 주석은 "동일" 이라고 하는데 실제로는 **달랐다** (2026-08-02 적대 검증이 잡음).
       events.py 판본에만 있던 것: `events:slug:*` · `events:transparency:*` ·
       `events:similar:` · 그리고 티어 목록 키.
       그래서 go sync 경로로 티어를 숨김 처리하면 **최대 300초 동안 옛 값이 공개
       엔드포인트로 나갔다.** 숨기는 조치가 5분 늦게 먹는다는 뜻이다.

    ⚠️ 두 판본이 따로 있는 한 또 갈라진다. 지금은 키 목록을 맞춰두고,
       통합은 별건으로 남긴다(이 배치에서 파일을 합치면 회귀 표면이 커진다).
    """
    import asyncio

    exact_keys = [
        "events:categories",
        "events:featured",
        "events:trending",
        "events:opening_soon",
    ]
    if event_id is not None:
        exact_keys.append(f"events:detail:{event_id}")
        # 티어 목록 캐시 — 티어를 숨김/비활성으로 바꿔도 이게 없으면 TTL 동안 옛 값이 나간다.
        exact_keys.append(f"tiers:list:v2:{event_id}")
        exact_keys.append(f"tiers:list:{event_id}")  # 옛 키 잔존분
    await cache_delete_many(exact_keys)

    patterns = [
        "events:list:*",
        "events:search:*",
        "events:ranking:*",
        "events:public_list:*",
        "events:public_report:*",
        "events:slug:*",
    ]
    if event_id is not None:
        patterns.extend([
            f"events:transparency:{event_id}:*",
            f"events:similar:{event_id}",
        ])
    await asyncio.gather(*(cache_delete_pattern(p) for p in patterns))


def _parse_iso(value: str) -> datetime:
    # go는 ISO 8601 문자열로 보냄. `Z` 접미사 대응.
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


async def _upsert_phase_configs(
    session, event_id: uuid.UUID, schedules: list[PhaseSchedulePayload]
) -> tuple[datetime | None, datetime | None]:
    """go phaseSchedules → v2 phase_configs 병합 upsert.

    phase_configs 가 판매계획의 SSOT다. 주최자 판매계획의 **정본 write 경로**는
    `internal_commerce` 의 `PUT /events/{id}/sale-plan` 이며(레벨2 컷오버 T2-PHASE),
    이 함수는 심사요청 웹훅의 **보조 경로**로만 남는다.

    ⚠️ 과거 구현은 delete-then-insert 였다. 그래서
      (a) 빈 배열이 오면 이벤트의 phase 가 통째로 사라졌고,
      (b) 값이 와도 status/target_quantity/allocated_quantity/config 가 매번 리셋됐다.
    지금은 (event_id, phase) 키 병합 upsert 로 바꿔 둘 다 막는다:
      - payload 에 없는 phase 는 **지우지 않는다**(보조 경로가 정본을 파괴하지 못함).
      - 기존 행은 시각/순서만 갱신하고 T2 컬럼은 보존한다.

    Returns: (earliest starts_at, latest ends_at) — Event.bidding_opens_at /
    bidding_closes_at 자동 계산용. payload 가 비어도 **DB 의 기존 phase 로부터**
    계산해 반환한다(정본 경로가 이미 써둔 판매창을 웹훅이 되돌리지 않도록).
    """
    if not schedules:
        return await _phase_window_from_db(session, event_id)

    sorted_schedules = sorted(schedules, key=lambda s: s.phaseOrder)
    parsed: list[tuple[PhaseSchedulePayload, datetime, datetime]] = []
    for s in sorted_schedules:
        try:
            opens = _parse_iso(s.opensAt)
            closes = _parse_iso(s.closesAt)
        except (ValueError, TypeError) as exc:
            logger.warning(
                "phase_configs: invalid datetime for event=%s mode=%s: %s",
                event_id, s.mode, exc,
            )
            continue
        parsed.append((s, opens, closes))

    if not parsed:
        # 전부 파싱 실패 — 아무것도 지우지 않고 기존 상태를 그대로 유지한다.
        return await _phase_window_from_db(session, event_id)

    existing_rows = (
        await session.execute(
            select(PhaseConfig).where(PhaseConfig.event_id == event_id)
        )
    ).scalars().all()
    by_phase = {row.phase: row for row in existing_rows}

    for s, opens, closes in parsed:
        row = by_phase.get(s.mode)
        if row is None:
            session.add(
                PhaseConfig(
                    event_id=event_id,
                    phase=s.mode,
                    starts_at=opens,
                    ends_at=closes,
                    sort_order=s.phaseOrder,
                )
            )
        else:
            # 이미 진행/완료된 단계의 시각은 건드리지 않는다(사후 변경 금지).
            if row.status in ("scheduled",):
                row.starts_at = opens
                row.ends_at = closes
            row.sort_order = s.phaseOrder

    await session.flush()

    earliest_opens = min(p[1] for p in parsed)
    latest_closes = max(p[2] for p in parsed)
    return (earliest_opens, latest_closes)


async def _phase_window_from_db(
    session, event_id: uuid.UUID
) -> tuple[datetime | None, datetime | None]:
    """DB 의 기존 phase_configs 로부터 (최초 시작, 최종 종료) 산출."""
    rows = (
        await session.execute(
            select(PhaseConfig).where(PhaseConfig.event_id == event_id)
        )
    ).scalars().all()
    if not rows:
        return (None, None)
    starts = [r.starts_at for r in rows if r.starts_at is not None]
    ends = [r.ends_at for r in rows if r.ends_at is not None]
    return (min(starts) if starts else None, max(ends) if ends else None)


async def _upsert_event_mirror(
    session,
    event_id: uuid.UUID,
    participants: list["ParticipantPayload"],
    notices: list["OpenNoticePayload"],
    facilities: list["FacilityPayload"],
) -> None:
    """go 미러(출연진/공지/시설) → v2 delete-then-insert (단계5). go가 truth.

    payload에 없으면 빈 리스트 → 해당 미러 비움(go 측 삭제를 그대로 반영).
    """
    from sqlalchemy import delete as sql_delete

    # 1) 출연진/라인업
    await session.execute(
        sql_delete(EventParticipant).where(EventParticipant.event_id == event_id)
    )
    for p in participants:
        session.add(
            EventParticipant(
                event_id=event_id,
                name=p.name,
                role=p.role,
                bio=p.bio,
                image_url=p.imageUrl,
                sort_order=p.sortOrder,
            )
        )

    # 2) 공개 공지
    await session.execute(
        sql_delete(EventAnnouncement).where(EventAnnouncement.event_id == event_id)
    )
    for n in notices:
        published = None
        if n.publishedAt:
            try:
                published = _parse_iso(n.publishedAt)
            except (ValueError, TypeError):
                logger.warning(
                    "event_announcements: invalid publishedAt event=%s: %s",
                    event_id, n.publishedAt,
                )
        session.add(
            EventAnnouncement(
                event_id=event_id,
                notice_type=n.type,
                title=n.title,
                content=n.content,
                published_at=published,
            )
        )

    # 3) 시설
    await session.execute(
        sql_delete(EventFacility).where(EventFacility.event_id == event_id)
    )
    for f in facilities:
        session.add(
            EventFacility(
                event_id=event_id,
                name=f.name,
                category=f.category,
                quantity=f.quantity,
                status=f.status,
            )
        )

    await session.flush()


# ── Grid layout sync: 격자 모드 배치도 → v2 venue_sections ─────────────


class GridSectionPayload(BaseModel):
    name: str
    center_x: float
    center_y: float
    width: float
    height: float
    capacity: int
    color_hex: str = "#1E2A78"
    # 피그마 빌더 메타데이터 (go 신버전부터 전송). 구버전 페이로드 호환을 위해 기본값 둠.
    kind: str = "assigned"
    rotation: float = 0.0


class GridLayoutSyncRequest(BaseModel):
    eventId: str
    sections: list[GridSectionPayload]


class GridLayoutSyncResponse(BaseModel):
    ok: bool
    eventId: str
    sectionsUpserted: int = 0


@router.post(
    "/grid-layout/sync",
    response_model=GridLayoutSyncResponse,
    summary="go 격자 배치도 → v2 venue_sections 동기화",
)
async def sync_grid_layout(request: Request):
    """격자 모드로 그린 구역 정보(위치+크기+색상)를 v2 venue_sections로 upsert."""

    raw_body = await request.body()
    await verify_pickket_webhook(
        request,
        raw_body,
        settings.GO_WEBHOOK_SECRET,
        source="go",
        guard_replay=True,
    )

    try:
        data = GridLayoutSyncRequest(**json.loads(raw_body))
    except Exception as exc:
        logger.warning("grid-layout/sync: invalid payload: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid payload: {exc}",
        ) from exc

    try:
        event_id = uuid.UUID(data.eventId)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"eventId must be a UUID: {data.eventId}",
        ) from exc

    sections_upserted = 0

    async with async_session() as session:
        event = await session.get(Event, event_id)
        if not event:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Event {data.eventId} not found. Call /events/sync first.",
            )

        venue_id = event.venue_id
        if not venue_id:
            # event.venue_id 없으면 event.id로 auto-create venue
            venue = Venue(
                id=event_id,
                name=event.venue or "장소 미정",
                city="",
                address="",
                total_capacity=event.total_seats or 0,
            )
            session.add(venue)
            await session.flush()
            event.venue_id = venue.id
            venue_id = venue.id

        # 기존 venue_sections (이 venue에 속한) 조회
        existing_sections = (
            await session.execute(
                select(VenueSection).where(VenueSection.venue_id == venue_id)
            )
        ).scalars().all()
        existing_by_name = {s.name: s for s in existing_sections}

        incoming_names = {s.name for s in data.sections}

        for section_data in data.sections:
            existing = existing_by_name.get(section_data.name)
            if existing:
                existing.capacity = section_data.capacity
                existing.center_x = section_data.center_x
                existing.center_y = section_data.center_y
                existing.color = section_data.color_hex
                existing.kind = section_data.kind
                existing.rotation = section_data.rotation
                existing.width = section_data.width
                existing.height = section_data.height
            else:
                new_section = VenueSection(
                    venue_id=venue_id,
                    name=section_data.name,
                    label=section_data.name,
                    capacity=section_data.capacity,
                    center_x=section_data.center_x,
                    center_y=section_data.center_y,
                    color=section_data.color_hex,
                    kind=section_data.kind,
                    rotation=section_data.rotation,
                    width=section_data.width,
                    height=section_data.height,
                )
                session.add(new_section)
            sections_upserted += 1

        # 페이로드에 없는 기존 섹션 제거 — 주최자가 피그마에서 삭제한 섹션 반영
        for name, section in existing_by_name.items():
            if name not in incoming_names:
                await session.delete(section)

        # venue map 크기 업데이트 (섹션 bounding box에 맞춰서)
        if data.sections:
            max_x = max(s.center_x + s.width / 2 for s in data.sections)
            max_y = max(s.center_y + s.height / 2 for s in data.sections)
            venue = await session.get(Venue, venue_id)
            if venue:
                venue.map_width = int(max(max_x + 100, 1000))
                venue.map_height = int(max(max_y + 100, 800))

        await session.commit()

    logger.info(
        "grid-layout/sync completed: event=%s upserted=%d",
        data.eventId,
        sections_upserted,
    )

    return GridLayoutSyncResponse(
        ok=True,
        eventId=data.eventId,
        sectionsUpserted=sections_upserted,
    )


# ── Product sync: go products → v2 seat_tiers (좌석도 없는 FCFS 판매용) ─────


# ── Review requested: go → v2 심사 요청 수신 ─────────────────────────────


class ReviewRequestPayload(BaseModel):
    eventId: str
    slug: str
    title: str
    summary: str | None = None
    description: str | None = None
    eventType: str
    startsAt: str
    endsAt: str
    venueName: str | None = None
    venueAddress: str | None = None
    heroImageUrl: str | None = None
    maxAttendees: int | None = None
    isOnline: bool = False
    ageRating: str | None = None
    organizerEmail: str | None = None
    organizerName: str | None = None
    phaseSchedules: list[PhaseSchedulePayload] = Field(default_factory=list)


class ReviewRequestResponse(BaseModel):
    ok: bool
    eventId: str


@router.post(
    "/events/review-requested",
    response_model=ReviewRequestResponse,
    summary="go → v2 이���트 심사 요청 수신",
)
async def receive_review_request(request: Request):
    """go에서 주��자가 심사 요청한 이벤트를 v2 DB에 pending_review 상태로 저장."""

    raw_body = await request.body()

    await verify_pickket_webhook(
        request,
        raw_body,
        settings.GO_WEBHOOK_SECRET,
        source="go",
        guard_replay=True,
    )

    try:
        data = ReviewRequestPayload(**json.loads(raw_body))
    except Exception as exc:
        logger.warning("events/review-requested: invalid payload: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid payload: {exc}",
        ) from exc

    try:
        event_id = uuid.UUID(data.eventId)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"eventId must be a UUID: {data.eventId}",
        ) from exc

    starts_at = _parse_iso(data.startsAt)
    ends_at = _parse_iso(data.endsAt)
    category = GO_EVENT_TYPE_TO_V2_CATEGORY.get(data.eventType.lower(), "concert")
    venue_name = data.venueName or ("온라인" if data.isOnline else "장��� 미정")
    total_seats = data.maxAttendees or 1000

    async with async_session() as session:
        # venue auto-create
        venue = await session.get(Venue, event_id)
        if not venue:
            venue = Venue(
                id=event_id,
                name=venue_name,
                city="",
                address=data.venueAddress or "",
                total_capacity=total_seats,
            )
            session.add(venue)
            await session.flush()
        else:
            venue.name = venue_name
            if data.venueAddress:
                venue.address = data.venueAddress
            venue.total_capacity = total_seats

        existing = await session.get(Event, event_id)
        if existing is None:
            # 이벤트 정체성 단일화(GO_V2_COMMERCE_SYNC_AUDIT (B)): 커머스 write-through 가
            # external_ref(=go id)로 이미 만든 이벤트가 있으면 그걸 재사용(v2 이벤트 이원화 방지).
            existing = (
                await session.execute(
                    select(Event).where(Event.external_ref == str(event_id))
                )
            ).scalar_one_or_none()

        # phase_configs upsert — phase SSOT
        ph_opens, ph_closes = await _upsert_phase_configs(
            session, event_id, data.phaseSchedules
        )
        effective_opens = ph_opens if ph_opens else (starts_at - timedelta(days=7))
        effective_closes = ph_closes if ph_closes else starts_at

        if existing:
            existing.title = data.title
            existing.slug = data.slug
            existing.description = data.description or data.summary
            existing.venue = venue_name
            existing.venue_id = venue.id
            existing.event_date = starts_at
            existing.bidding_opens_at = effective_opens
            existing.bidding_closes_at = effective_closes
            existing.total_seats = total_seats
            existing.category = category
            existing.image_url = data.heroImageUrl
            existing.age_restriction = data.ageRating
            existing.status = EventStatus.PENDING_REVIEW
        else:
            organizer_id = await _get_or_create_go_system_user(session)
            new_event = Event(
                id=event_id,
                external_ref=str(event_id),  # 정체성 단일화 — 커머스 write-through 와 멱등 매칭
                organizer_id=organizer_id,
                title=data.title,
                slug=data.slug,
                description=data.description or data.summary,
                venue=venue_name,
                venue_id=venue.id,
                event_date=starts_at,
                bidding_opens_at=effective_opens,
                bidding_closes_at=effective_closes,
                total_seats=total_seats,
                category=category,
                image_url=data.heroImageUrl,
                age_restriction=data.ageRating,
                status=EventStatus.PENDING_REVIEW,
            )
            session.add(new_event)

        await session.commit()

    await _invalidate_event_caches(event_id)

    logger.info(
        "events/review-requested: eventId=%s title=%s",
        data.eventId,
        data.title,
    )

    return ReviewRequestResponse(ok=True, eventId=data.eventId)


class ProductPayload(BaseModel):
    id: str
    name: str
    price: float
    stock: int | None = None  # None = unlimited
    saleMode: str = "fixed_fcfs"
    isActive: bool = True


class ProductsSyncRequest(BaseModel):
    eventId: str
    products: list[ProductPayload]


class ProductsSyncResponse(BaseModel):
    ok: bool
    eventId: str
    tiersUpserted: int = 0
    tiersDeleted: int = 0


@router.post(
    "/products/sync",
    response_model=ProductsSyncResponse,
    summary="go → v2 상품 동기화 (선착순 티켓 → seat_tier)",
)
async def sync_products(request: Request):
    """pickket-go 상품을 v2 seat_tier로 upsert. 좌석도 없는 FCFS 판매 시 사용."""

    raw_body = await request.body()
    await verify_pickket_webhook(
        request,
        raw_body,
        settings.GO_WEBHOOK_SECRET,
        source="go",
        guard_replay=True,
    )

    try:
        data = ProductsSyncRequest(**json.loads(raw_body))
    except Exception as exc:
        logger.warning("products/sync: invalid payload: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid payload: {exc}",
        ) from exc

    try:
        event_id = uuid.UUID(data.eventId)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"eventId must be a UUID: {data.eventId}",
        ) from exc

    tiers_upserted = 0
    tiers_deleted = 0

    async with async_session() as session:
        # 이벤트 존재 확인 (events/sync 먼저 호출되어 있어야 함)
        event = await session.get(Event, event_id)
        if not event:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Event {data.eventId} not found in v2. Call /events/sync first.",
            )

        incoming_ids = {uuid.UUID(p.id) for p in data.products if p.isActive}

        # 기존 tier 조회
        existing_tiers = (
            await session.execute(select(SeatTier).where(SeatTier.event_id == event_id))
        ).scalars().all()
        existing_by_id = {t.id: t for t in existing_tiers}

        # 1) upsert active products
        for product in data.products:
            if not product.isActive:
                continue
            tier_uuid = uuid.UUID(product.id)
            capacity = product.stock if product.stock is not None else 999999

            if tier_uuid in existing_by_id:
                tier = existing_by_id[tier_uuid]
                tier.name = product.name
                tier.capacity = capacity
                tier.base_price = product.price
                tier.face_price = product.price
                tier.min_price = product.price
                tier.sale_mode = product.saleMode
            else:
                new_tier = SeatTier(
                    id=tier_uuid,
                    event_id=event_id,
                    name=product.name,
                    capacity=capacity,
                    base_price=product.price,
                    face_price=product.price,
                    min_price=product.price,
                    sale_mode=product.saleMode,
                    seating_type="standing",
                    section_name="A",
                )
                session.add(new_tier)
            tiers_upserted += 1

        # 2) 누락된 기존 tier는 sold_count=0일 때만 capacity=0으로 soft delete
        # (주문이 이미 있는 tier는 check constraint 위반 방지 위해 그대로 둠)
        for tier_id, tier in existing_by_id.items():
            if tier_id not in incoming_ids and (tier.sold_count or 0) == 0:
                tier.capacity = 0
                tiers_deleted += 1

        # min_price 반영: 활성 상품 최저가 → event.min_price
        active_prices = [p.price for p in data.products if p.isActive]
        if active_prices:
            event.min_price = min(active_prices)

        await session.commit()

    logger.info(
        "products/sync completed: event=%s upserted=%d deleted=%d",
        data.eventId,
        tiers_upserted,
        tiers_deleted,
    )

    return ProductsSyncResponse(
        ok=True,
        eventId=data.eventId,
        tiersUpserted=tiers_upserted,
        tiersDeleted=tiers_deleted,
    )


# ── Lottery Stats (go 주최자 대시보드용) ────────────────────────────────

class TierLotteryStats(BaseModel):
    tierId: str
    tierName: str
    seats: int
    entries: int
    applicants: int
    competitionRatio: float
    winnersCount: int | None = None
    totalApInvested: int

class LotteryStatsResponse(BaseModel):
    eventId: str
    phase: str
    stats: dict
    byTier: list[TierLotteryStats]
    drawExecutedAt: str | None = None


@router.get("/events/{event_id}/lottery-stats")
async def lottery_stats(event_id: uuid.UUID, request: Request):
    """주최자 대시보드용 응모 통계. go에서 X-Pickket-Service-Token으로 호출."""
    # S-1(#23): 분리된 서비스 토큰(GO_WEBHOOK_SECRET 아님) timing-safe 검증.
    _require_service_token(request)

    from sqlalchemy import func as F
    from app.models.lottery import LotteryPool, LotteryEntry, LotteryPoolStatus, LotteryEntryResult

    async with async_session() as db:
        # 이벤트 존재 확인
        ev = await db.execute(select(Event.id, Event.status).where(Event.id == event_id))
        event_row = ev.first()
        if not event_row:
            raise HTTPException(status_code=404, detail="Event not found")

        # 풀 조회
        pools_q = await db.execute(
            select(LotteryPool).where(LotteryPool.event_id == event_id)
        )
        pools = pools_q.scalars().all()

        if not pools:
            return LotteryStatsResponse(
                eventId=str(event_id),
                phase="pre_apply",
                stats={
                    "totalEntries": 0, "totalApplicants": 0, "totalSeats": 0,
                    "competitionRatio": 0, "winnersCount": None, "waitlistedCount": None,
                    "losersCount": None, "totalApInvested": 0, "avgApPerEntry": 0,
                },
                byTier=[],
            )

        # phase 결정
        pool_statuses = {p.status for p in pools}
        draw_executed_at = None
        if all(s == LotteryPoolStatus.DRAWN for s in pool_statuses):
            phase = "drawn"
            # 추첨 시각 = 가장 늦게 추첨된 풀의 drawn_at. 🔴 예전엔 풀 생성 시각(첫 응모 시각)을 써서
            #    주최사 화면이 응모 마감 전에 추첨한 것처럼 보였다(실측 2026-11-18).
            drawn_times = [p.drawn_at for p in pools if p.drawn_at is not None]
            latest_drawn = max(drawn_times) if drawn_times else None
            draw_executed_at = latest_drawn.isoformat() if latest_drawn else None
        elif any(s == LotteryPoolStatus.DRAWN for s in pool_statuses):
            phase = "drawing"
        elif all(s == LotteryPoolStatus.CLOSED for s in pool_statuses):
            phase = "closed"
        else:
            phase = "applying"

        pool_ids = [p.id for p in pools]
        pool_map = {p.id: p for p in pools}

        # 엔트리 집계
        entries_q = await db.execute(
            select(LotteryEntry).where(LotteryEntry.pool_id.in_(pool_ids))
        )
        entries = entries_q.scalars().all()

        total_entries = len(entries)
        unique_users = len({e.user_id for e in entries})
        total_seats = sum(p.total_seats for p in pools)
        total_ap = sum(e.invested_ap or 0 for e in entries)
        winners = [e for e in entries if e.result == LotteryEntryResult.WON]
        waitlisted = [e for e in entries if e.result == LotteryEntryResult.WAITLISTED]
        # pending이 아닌 것 중 won/waitlisted도 아닌 것 = loser
        losers_count = total_entries - len(winners) - len(waitlisted)
        # drawing 전이면 winner/waitlist/loser는 null
        has_drawn = phase in ("drawn", "completed")

        # tier별 집계
        tier_ids = list({p.tier_id for p in pools})
        tiers_q = await db.execute(select(SeatTier).where(SeatTier.id.in_(tier_ids)))
        tiers_map = {t.id: t for t in tiers_q.scalars().all()}

        by_tier = []
        for pool in pools:
            tier = tiers_map.get(pool.tier_id)
            pool_entries = [e for e in entries if e.pool_id == pool.id]
            pool_users = len({e.user_id for e in pool_entries})
            pool_winners = len([e for e in pool_entries if e.result == LotteryEntryResult.WON])
            pool_ap = sum(e.invested_ap or 0 for e in pool_entries)
            by_tier.append(TierLotteryStats(
                tierId=str(pool.tier_id),
                tierName=tier.name if tier else "—",
                seats=pool.total_seats,
                entries=len(pool_entries),
                applicants=pool_users,
                competitionRatio=round(len(pool_entries) / max(pool.total_seats, 1), 2),
                winnersCount=pool_winners if has_drawn else None,
                totalApInvested=pool_ap,
            ))

        return LotteryStatsResponse(
            eventId=str(event_id),
            phase=phase,
            stats={
                "totalEntries": total_entries,
                "totalApplicants": unique_users,
                "totalSeats": total_seats,
                "competitionRatio": round(total_entries / max(total_seats, 1), 2),
                "winnersCount": len(winners) if has_drawn else None,
                "waitlistedCount": len(waitlisted) if has_drawn else None,
                "losersCount": losers_count if has_drawn else None,
                "totalApInvested": total_ap,
                "avgApPerEntry": round(total_ap / max(total_entries, 1), 1),
            },
            byTier=by_tier,
            drawExecutedAt=draw_executed_at,
        )


# ── Phase Transition (go → v2 단계 전이 알림) ────────────────────────────

async def _notify_go_fcfs_converted(event_id: uuid.UUID, closes_at) -> None:
    """go 대시보드용 fcfs-converted callback.

    ⚠️ 레벨2 컷오버 T2-PHASE 이후 **dormant** 다.
    - go 수신 라우트(`/api/webhooks/v2/fcfs-converted`)는 제거됐다(404 예상).
    - 이 함수를 부르는 `phase_transition` 핸들러 자체가 go `phase-transition-sync` 제거로
      더 이상 호출되지 않는다.
    - go 대시보드의 '선착순 전환됨' 뱃지는 이제 v2 판매 단계 SSOT(phase_configs 의
      fcfs_residual status=open)를 직접 읽어 판정한다(lottery-stats 라우트).
    호출자가 예외를 삼키므로(warning 로그) 잔존 트래픽이 있어도 안전하다. 계약 잔재로 남겨둔다.

    env 없으면 skip. 네트워크 오류 등은 호출자가 캐치하도록 raise.
    """
    if not settings.GO_INTERNAL_BASE_URL or not settings.GO_WEBHOOK_SECRET:
        logger.debug("GO callback skipped — env not configured")
        return

    import httpx

    from app.services.go_review_webhook import _compute_signature

    url = f"{settings.GO_INTERNAL_BASE_URL.rstrip('/')}/api/webhooks/v2/fcfs-converted"
    now = datetime.now(timezone.utc)
    timestamp = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    delivery_id = str(uuid.uuid4())
    payload = {
        "event_id": str(event_id),
        "converted_at": now.isoformat(),
        "closes_at": closes_at.isoformat() if closes_at else None,
    }
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    signature = _compute_signature(settings.GO_WEBHOOK_SECRET, timestamp, body)

    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.post(
            url,
            content=body,
            headers=traced_headers({
                "Content-Type": "application/json",
                "X-Pickket-Signature": signature,
                "X-Pickket-Timestamp": timestamp,
                "X-Pickket-Event": "event.fcfs_converted",
                "X-Pickket-Delivery-Id": delivery_id,
                "User-Agent": "Pickket-V2/2.0",
            }),
        )
        if resp.status_code >= 400:
            logger.warning(
                "fcfs-converted callback non-2xx: event=%s status=%d body=%s",
                event_id, resp.status_code, resp.text[:200],
            )
        else:
            logger.info("fcfs-converted callback ok: event=%s", event_id)


class PhaseTransitionPayload(BaseModel):
    phase: str  # membership_presale | lottery | waitlist_promotion | queue_sale | fcfs_residual
    phaseOrder: int = 1
    status: str  # open | closed | scheduled | allocating | allocated | skipped
    opensAt: str | None = None
    closesAt: str | None = None
    quota: int | None = None  # target_quantity (null이면 이월분 전부)
    config: dict | None = None  # payment_window_hours 등


# (phase, status) → v2 EventStatus 전이 매핑 결과. side-effect 없는 순수 데이터.
class PhaseTransitionOutcome(BaseModel):
    # 목표 EventStatus (None = event.status 변경 없음)
    target_status: EventStatus | None = None
    # mapped   : 매핑 존재, target_status 로 전이
    # gated    : 매핑은 존재하나 feature-flag OFF 로 전파 보류(현행 무전이 유지)
    # unmapped : (mode×status) 조합에 해당 분기 없음 → 조용한 유실 금지(ERROR 로그+메트릭)
    outcome: str = "unmapped"


# fcfs 판매단계로 취급하는 phase(잔여 선착순·큐 판매) — close 시 BIDDING_CLOSED.
_FCFS_SALE_PHASES = ("fcfs_residual", "queue_sale")


def resolve_phase_transition_target(
    phase: str,
    status: str,
    *,
    fcfs_closed_enabled: bool,
) -> PhaseTransitionOutcome:
    """go phase 전이 → v2 event.status 목표를 결정하는 순수 매핑 함수.

    ⚠️ 여기서 event.bidding_closes_at·캐시·콜백·추첨트리거 등 **부수효과는 결정하지 않는다**
    (핸들러가 outcome 을 보고 수행). 계약 골든 테스트가 (mode×status) 전 조합을 이 함수로 단언.

    T1-2(F1): fcfs_residual(+queue_sale)+closed → BIDDING_CLOSED 분기 추가.
    lottery/membership+closed(BIDDING_CLOSED)와 일관. 단 feature-flag(PHASE_TRANSITION_FCFS_CLOSED)
    로 게이트 — flag OFF 면 gated(무전이)로 현행 유지(배포 시 dormant, 관제 관측 후 활성).
    """
    if phase in ("membership_presale", "lottery") and status == "open":
        return PhaseTransitionOutcome(target_status=EventStatus.BIDDING_OPEN, outcome="mapped")
    if phase in ("membership_presale", "lottery") and status == "closed":
        return PhaseTransitionOutcome(target_status=EventStatus.BIDDING_CLOSED, outcome="mapped")
    if phase == "fcfs_residual" and status == "open":
        return PhaseTransitionOutcome(target_status=EventStatus.BIDDING_OPEN, outcome="mapped")
    if phase in _FCFS_SALE_PHASES and status == "closed":
        # T1-2 신규 분기 — flag 로 게이트.
        if not fcfs_closed_enabled:
            return PhaseTransitionOutcome(target_status=None, outcome="gated")
        return PhaseTransitionOutcome(target_status=EventStatus.BIDDING_CLOSED, outcome="mapped")
    if status == "allocated":
        return PhaseTransitionOutcome(target_status=EventStatus.ALLOCATED, outcome="mapped")
    # 미매핑: 조용히 200 반환하되 outcome=unmapped 로 명시(핸들러가 ERROR 로그+메트릭).
    return PhaseTransitionOutcome(target_status=None, outcome="unmapped")


@router.post("/events/{event_id}/phase-transition")
async def phase_transition(
    event_id: uuid.UUID,
    data: PhaseTransitionPayload,
    request: Request,
):
    """go에서 phase 전이 시 호출. 이벤트 상태 동기화 + 자동 추첨 트리거."""
    # S-1(#23): 분리된 서비스 토큰(GO_WEBHOOK_SECRET 아님) timing-safe 검증.
    _require_service_token(request)

    async with async_session() as db:
        # 이벤트 존재 확인
        ev_q = await db.execute(select(Event).where(Event.id == event_id))
        event = ev_q.scalar_one_or_none()
        if not event:
            raise HTTPException(status_code=404, detail="Event not found")

        # phase 상태에 따라 이벤트 상태 동기화.
        # ⚠️ event.bidding_closes_at 은 "이벤트 전체 판매 종료"(= 보통 event_date)여야 함.
        # phase 별 closes_at 을 여기 덮어쓰면 v2 get_event 자동 전환 로직이
        # phase 끝남 == event 마감으로 오판해서 목록에서 조기 숨김 → go 와 상태 불일치.
        # phase 별 closes_at 은 go SSOT + lottery-stats API 로 관리, v2 는 건드리지 않음.
        #
        # TODO(F19): 이 핸들러는 event.status 를 read-modify-write 하는데 분산락이 없다
        #   (auto-window 전이는 Redis NX 락 사용, 여기만 없음) → 동시 phase 전이 시 lost update
        #   위험. go 의 fire-and-forget 재시도/중복 호출과 겹치면 마지막 쓰기가 이긴다.
        #   Track 2(T2-C: 분산락+replay guard)로 이관. 이번 스코프는 매핑 완전화만.
        #
        # 전이 목표는 순수 매핑 함수(resolve_phase_transition_target)가 결정 —
        # 부수효과(캐시/콜백/추첨)는 아래 (phase,status) 분기가 담당. 계약 골든 테스트는
        # 매핑 함수만 단언(mode×status 전 조합).
        fcfs_closed_enabled = await get_feature_flag(
            "phase_transition_fcfs_closed", settings.PHASE_TRANSITION_FCFS_CLOSED
        )
        _outcome = resolve_phase_transition_target(
            data.phase, data.status, fcfs_closed_enabled=bool(fcfs_closed_enabled)
        )
        try:
            PHASE_TRANSITION_TOTAL.labels(
                phase=data.phase, status=data.status, outcome=_outcome.outcome
            ).inc()
        except Exception:
            logger.debug("phase_transition metric emit failed", exc_info=True)

        if _outcome.outcome == "unmapped":
            # 조용한 유실 금지(F1): 매칭 분기 없음 → 구조화 ERROR 로그. raise/500 금지
            # (go 는 fire-and-forget — 500 이면 재시도 폭주). 응답 200 유지, body 에 unmapped 표기.
            logger.error(
                "phase_transition unmapped combination — no v2 status transition applied "
                "(event=%s phase=%s status=%s quota=%s)",
                event_id, data.phase, data.status, data.quota,
            )
        elif _outcome.outcome == "gated":
            # 매핑은 존재하나 feature-flag OFF — 현행(무전이) 유지. 관측용 INFO.
            logger.info(
                "phase_transition gated by PHASE_TRANSITION_FCFS_CLOSED=OFF "
                "(event=%s phase=%s status=%s) — no transition",
                event_id, data.phase, data.status,
            )

        # 매핑된 목표상태를 먼저 적용(gated/unmapped 는 target_status=None → 무전이).
        if _outcome.target_status is not None:
            event.status = _outcome.target_status

        # 부수효과 — (phase,status) 별. 위 매핑과 동일 조건, side-effect 만 담당.
        if data.phase in ("membership_presale", "lottery") and data.status == "open":
            # event.bidding_closes_at 은 event_date 기준으로 최소 보장 (phase closes_at 무시)
            if event.bidding_closes_at is None or event.bidding_closes_at < event.event_date:
                event.bidding_closes_at = event.event_date
            # 활성 phase 플래그 저장 — apply() 에서 이 값 확인해 응모 허용 여부 판정
            await cache_set(
                f"event:{event_id}:active_phase", data.phase, ttl=604800
            )
            # phase 별 closes_at 저장 — consumer 카운트다운이 이 값을 보여줌
            # (event.bidding_closes_at = event_date 는 공연 당일이라 phase 마감과 다름)
            if data.closesAt:
                await cache_set(
                    f"event:{event_id}:phase_closes_at",
                    data.closesAt,
                    ttl=604800,
                )
        elif data.phase in ("membership_presale", "lottery") and data.status == "closed":
            # phase 닫힘 → 활성 phase 플래그 + closes_at 제거
            await cache_delete_many([
                f"event:{event_id}:active_phase",
                f"event:{event_id}:phase_closes_at",
            ])
        elif data.phase == "fcfs_residual" and data.status == "open":
            # 잔여 선착순 기간: 이벤트 당일까지 (bidding_closes_at NOT NULL 제약)
            # config.fcfs_close_at 있으면 그 값 사용, 없으면 event_date까지
            if data.config and data.config.get("closes_at"):
                from datetime import datetime as _dt
                try:
                    event.bidding_closes_at = _dt.fromisoformat(
                        data.config["closes_at"].replace("Z", "+00:00")
                    )
                except (ValueError, TypeError):
                    event.bidding_closes_at = event.event_date
            else:
                event.bidding_closes_at = event.event_date
            # tier sale_mode도 fcfs로 전환
            from sqlalchemy import update as sql_update
            await db.execute(
                sql_update(SeatTier)
                .where(SeatTier.event_id == event_id)
                .values(sale_mode="fixed_fcfs")
            )
            # go 대시보드용 callback: fcfs-converted 이벤트 전달
            # (실패해도 phase-transition 자체는 성공 처리)
            try:
                await _notify_go_fcfs_converted(event_id, event.bidding_closes_at)
            except Exception as e:
                logger.warning("fcfs-converted callback to go failed: %s", e)
        elif data.phase in _FCFS_SALE_PHASES and data.status == "closed":
            # T1-2(F1) 신규: go fcfs/큐 판매단계 close → v2 BIDDING_CLOSED.
            # flag OFF 면 위에서 outcome=gated 라 target_status=None(무전이) → 이 부수효과도 스킵.
            # lottery/membership+closed 와 일관되게 활성 phase 플래그 정리.
            if _outcome.outcome == "mapped":
                await cache_delete_many([
                    f"event:{event_id}:active_phase",
                    f"event:{event_id}:phase_closes_at",
                ])

        await db.commit()
        await cache_delete_many([
            f"events:detail:{event_id}",
            "events:featured",
            "events:trending",
        ])

        logger.info(
            "Phase transition: event=%s phase=%s status=%s quota=%s",
            event_id, data.phase, data.status, data.quota,
        )

        # go가 전달한 phase별 결제 기한 설정을 Redis에 저장 (lottery_service/payment_expiry에서 조회)
        # key 규약: v2:event:{event_id}:payment_window_hours, :waitlist_payment_window_hours
        # TTL 7일 — phase 종료 + grace 충분히 포함
        if data.config:
            if (pw := data.config.get("payment_window_hours")) is not None:
                await cache_set(
                    f"event:{event_id}:payment_window_hours", str(pw), ttl=604800
                )
            if (wpw := data.config.get("waitlist_payment_window_hours")) is not None:
                await cache_set(
                    f"event:{event_id}:waitlist_payment_window_hours",
                    str(wpw),
                    ttl=604800,
                )

        # 자동 추첨 트리거: lottery/membership phase가 closed되면 추첨 실행
        # docs §4-1: draw() 내부에서 실시간 available_seats를 재계산하므로
        # 이전 phase(membership)의 미결제 만료 좌석이 자동 이월됨.
        # quota는 주최자 의도 상한으로 전달 (초과분은 다음 phase가 흡수)
        draw_triggered = False
        if data.phase in ("membership_presale", "lottery") and data.status == "closed":
            from app.models.lottery import LotteryPool, LotteryPoolStatus
            pools_q = await db.execute(
                select(LotteryPool).where(
                    LotteryPool.event_id == event_id,
                    LotteryPool.status == LotteryPoolStatus.OPEN,
                )
            )
            pools = pools_q.scalars().all()
            if pools:
                from app.services.lottery_service import LotteryService
                svc = LotteryService(db)
                for pool in pools:
                    try:
                        result = await svc.draw(pool_id=pool.id, max_winners=data.quota)
                        draw_triggered = True
                        logger.info(
                            "Auto-draw triggered: pool=%s event=%s quota_hint=%s winners=%d waitlisted=%d",
                            pool.id, event_id,
                            data.quota if data.quota is not None else "None",
                            result.winners, result.waitlisted,
                        )
                    except Exception as e:
                        logger.error("Auto-draw failed: pool=%s error=%s", pool.id, e)
                await db.commit()

        return {
            "ok": True,
            "eventId": str(event_id),
            "phase": data.phase,
            "status": data.status,
            "drawTriggered": draw_triggered,
            # T1-2(F1): 매핑 결과 노출(가산적 필드). mapped | gated | unmapped.
            # go 는 fire-and-forget 이라 응답 소비 안 하나, 관측/디버깅·계약 명세용.
            # unmapped 여도 200(재시도 폭주 방지) — 유실은 서버 ERROR 로그+메트릭으로 포착.
            "mapping": _outcome.outcome,
            "unmapped": _outcome.outcome == "unmapped",
        }


# ── 멤버십 검증 API ────────────────────────────────────────────────────

@router.get("/memberships/check")
async def check_membership(
    request: Request,
    user_id: uuid.UUID,
    event_id: uuid.UUID | None = None,
    fanclub_id: uuid.UUID | None = None,
):
    """멤버십 회원 여부 확인. go 또는 v2 consumer에서 호출."""
    _require_service_token(request)
    from app.models.fanclub import FanclubMembership, Fanclub, MembershipStatus

    async with async_session() as db:
        # fanclub_id가 없으면 event의 community_id로 조회
        fc_id = fanclub_id
        if not fc_id and event_id:
            ev_q = await db.execute(
                select(Event.community_id).where(Event.id == event_id)
            )
            fc_id = ev_q.scalar_one_or_none()

        if not fc_id:
            return {"is_member": False, "reason": "no_fanclub_linked"}

        membership_q = await db.execute(
            select(FanclubMembership).where(
                FanclubMembership.user_id == user_id,
                FanclubMembership.fanclub_id == fc_id,
                FanclubMembership.status == MembershipStatus.ACTIVE.value,
            )
        )
        membership = membership_q.scalar_one_or_none()

        if not membership:
            return {"is_member": False, "tier": None, "status": None}

        # 만료 체크
        if membership.expires_at and membership.expires_at < datetime.now(timezone.utc):
            return {"is_member": False, "tier": membership.tier, "status": "expired"}

        return {
            "is_member": True,
            "tier": membership.tier,
            "status": membership.status,
            "fanclub_id": str(fc_id),
            "verified_at": membership.verified_at.isoformat() if membership.verified_at else None,
        }


# ── 팬클럽 내부 API (go 주최자 대시보드 프록시용) ──────────────────────

@router.get("/fanclubs")
async def internal_list_fanclubs(
    request: Request,
    organizer_id: uuid.UUID | None = None,
):
    """go 주최자 대시보드용: 주최자별 팬클럽 목록."""
    _require_service_token(request)
    from app.models.fanclub import Fanclub, FanclubMembership, MembershipStatus
    from sqlalchemy import func as F

    async with async_session() as db:
        query = select(Fanclub)
        if organizer_id:
            query = query.where(Fanclub.organizer_id == organizer_id)

        result = await db.execute(query.order_by(Fanclub.created_at.desc()))
        fanclubs = result.scalars().all()

        items = []
        for fc in fanclubs:
            count_q = await db.execute(
                select(F.count()).where(
                    FanclubMembership.fanclub_id == fc.id,
                    FanclubMembership.status == MembershipStatus.ACTIVE.value,
                )
            )
            count = count_q.scalar() or 0
            items.append({
                "id": str(fc.id),
                "name": fc.name,
                "organizer_id": str(fc.organizer_id) if fc.organizer_id else None,
                "artist_id": str(fc.artist_id) if fc.artist_id else None,
                "member_count": count,
                "created_at": fc.created_at.isoformat() if fc.created_at else None,
            })

        return {"fanclubs": items, "total": len(items)}


# ── Users import (go → v2 회원 통합용 BFF) ─────────────────────────────────


class UserImportPayload(BaseModel):
    """go의 회원/주최자 정보를 v2 users 로 import.

    같은 email 이 이미 v2 에 있으면 update (id 유지), 없으면 create.
    응답: v2_user_id 를 go가 받아서 자체 매핑에 저장.
    """
    email: str
    name: str
    # 비밀번호는 이미 go에서 해싱된 값 (bcrypt) — 그대로 저장 가능하면 가져옴.
    # 없으면 v2가 임시 placeholder 저장 (사용자가 v2 에서 비밀번호 재설정 필요).
    hashed_password: str | None = None
    phone: str | None = None
    is_organizer: bool = False
    is_admin: bool = False
    # Organizer 비즈니스 정보
    business_name: str | None = None
    business_registration_number: str | None = None
    business_representative: str | None = None
    business_phone: str | None = None
    settlement_bank: str | None = None
    settlement_account_holder: str | None = None
    settlement_account_number: str | None = None
    # go 측 ID (transition 매핑용)
    go_organizer_id: str | None = None
    go_user_id: str | None = None


class UserImportResponse(BaseModel):
    ok: bool
    v2_user_id: str
    email: str
    created: bool  # true=신규 create, false=기존 update


@router.post(
    "/users/import",
    response_model=UserImportResponse,
    summary="go → v2 회원/주최자 정보 import",
)
async def import_user_from_go(request: Request):
    """go BFF 통합용 — go 측 회원/주최자를 v2 users 로 upsert.

    HMAC 검증 후 email 기준 upsert. 신규면 create, 있으면 update (id 보존).
    """
    raw_body = await request.body()
    await verify_pickket_webhook(
        request,
        raw_body,
        settings.GO_WEBHOOK_SECRET,
        source="go",
        guard_replay=True,
    )

    try:
        data = UserImportPayload(**json.loads(raw_body))
    except Exception as exc:
        logger.warning("users/import: invalid payload: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid payload: {exc}",
        ) from exc

    async with async_session() as session:
        existing = (
            await session.execute(select(User).where(User.email == data.email))
        ).scalar_one_or_none()

        created = existing is None
        if existing:
            user = existing
            user.name = data.name or user.name
            if data.phone:
                user.phone = data.phone
            user.is_organizer = data.is_organizer or user.is_organizer
            if data.is_admin:
                user.is_admin = True
            # 정책 B: go password 우선 — go 가 hashed_password 보내면 v2 비번 덮어쓰기
            # (transition 기간 사용자 UX 보존, go 비번 그대로 사용 가능)
            if data.hashed_password:
                user.hashed_password = data.hashed_password
        else:
            user = User(
                email=data.email,
                name=data.name,
                hashed_password=data.hashed_password
                or "!imported-from-go-no-password!",
                phone=data.phone,
                is_organizer=data.is_organizer,
                is_admin=data.is_admin,
            )
            session.add(user)
            await session.flush()

        # Organizer 비즈니스 정보 (값 들어온 것만 update — 부분 업데이트 안전)
        if data.business_name is not None:
            user.business_name = data.business_name
        if data.business_registration_number is not None:
            user.business_registration_number = data.business_registration_number
        if data.business_representative is not None:
            user.business_representative = data.business_representative
        if data.business_phone is not None:
            user.business_phone = data.business_phone
        if data.settlement_bank is not None:
            user.settlement_bank = data.settlement_bank
        if data.settlement_account_holder is not None:
            user.settlement_account_holder = data.settlement_account_holder
        if data.settlement_account_number is not None:
            user.settlement_account_number = data.settlement_account_number
        if data.go_organizer_id is not None:
            user.go_organizer_id = data.go_organizer_id

        await session.commit()
        await session.refresh(user)

    logger.info(
        "users/import: email=%s v2_id=%s created=%s organizer=%s",
        data.email, user.id, created, data.is_organizer,
    )
    return UserImportResponse(
        ok=True,
        v2_user_id=str(user.id),
        email=user.email,
        created=created,
    )


# ── Organizer cutover (Phase 2): profiles + teams ────────────────────────


class OrganizerProfileImportPayload(BaseModel):
    """go accounts → v2 organizer_profiles 이관."""

    go_account_id: str
    owner_v2_user_id: str  # 이미 import 된 v2 user
    name: str = Field(..., min_length=1, max_length=200)
    slug: str = Field(..., min_length=1, max_length=100)
    business_number: str | None = None
    representative_name: str | None = None  # go 가 user.name fallback 으로 채움
    contact_email: str
    contact_phone: str | None = None
    trust_tier: str = "new"  # new|verified|premium
    trust_score: int = 0


class OrganizerProfileImportResponse(BaseModel):
    ok: bool
    v2_organizer_profile_id: str
    owner_v2_user_id: str
    created: bool


@router.post(
    "/organizer/profiles/import",
    response_model=OrganizerProfileImportResponse,
    summary="go → v2 organizer profile import",
)
async def import_organizer_profile(request: Request):
    """go accounts → v2 organizer_profiles 이관 (BFF cutover Phase 2).

    HMAC 검증 후 go_account_id 기준 upsert. slug 충돌 시 409.
    """
    raw_body = await request.body()
    await verify_pickket_webhook(
        request,
        raw_body,
        settings.GO_WEBHOOK_SECRET,
        source="go",
        guard_replay=True,
    )

    try:
        data = OrganizerProfileImportPayload(**json.loads(raw_body))
    except Exception as exc:
        logger.warning("organizer/profiles/import: invalid payload: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid payload: {exc}",
        ) from exc

    # trust_tier 검증
    try:
        tier_enum = TrustTier(data.trust_tier)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid trust_tier: {data.trust_tier}",
        )

    try:
        owner_uuid = uuid.UUID(data.owner_v2_user_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="owner_v2_user_id must be a UUID",
        )

    async with async_session() as session:
        # owner user 존재 확인
        owner = (
            await session.execute(select(User).where(User.id == owner_uuid))
        ).scalar_one_or_none()
        if not owner:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"owner user not found: {data.owner_v2_user_id}",
            )

        # go_account_id 기준 기존 프로필 검색
        existing = (
            await session.execute(
                select(OrganizerProfile).where(
                    OrganizerProfile.go_account_id == data.go_account_id
                )
            )
        ).scalar_one_or_none()

        # slug 충돌 검사 (다른 row 가 같은 slug 쓰면 409)
        slug_collision = (
            await session.execute(
                select(OrganizerProfile).where(
                    OrganizerProfile.slug == data.slug,
                    OrganizerProfile.go_account_id != data.go_account_id,
                )
            )
        ).scalar_one_or_none()
        if slug_collision is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"slug already used by another organizer: {data.slug}",
            )

        # owner user 의 기존 profile (user_id unique) 검사
        owner_existing = (
            await session.execute(
                select(OrganizerProfile).where(
                    OrganizerProfile.user_id == owner_uuid
                )
            )
        ).scalar_one_or_none()
        if owner_existing is not None and (
            existing is None or owner_existing.id != existing.id
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "owner user already has a different organizer_profile "
                    f"(profile_id={owner_existing.id}, go_account_id={owner_existing.go_account_id})"
                ),
            )

        created = existing is None
        if existing:
            profile = existing
            profile.user_id = owner_uuid
            profile.company_name = data.name
            profile.slug = data.slug
            if data.business_number is not None:
                profile.business_number = data.business_number
            if data.representative_name is not None:
                profile.representative_name = data.representative_name
            if data.contact_email is not None:
                profile.contact_email = data.contact_email
            if data.contact_phone is not None:
                profile.contact_phone = data.contact_phone
            profile.trust_tier = tier_enum
            profile.trust_score = data.trust_score
        else:
            profile = OrganizerProfile(
                user_id=owner_uuid,
                company_name=data.name,
                slug=data.slug,
                business_number=data.business_number,
                representative_name=data.representative_name,
                contact_email=data.contact_email,
                contact_phone=data.contact_phone,
                trust_tier=tier_enum,
                trust_score=data.trust_score,
                go_account_id=data.go_account_id,
                status=OrganizerStatus.APPROVED,  # go 에서 이미 승인된 상태로 import
                approved_at=datetime.now(timezone.utc),
            )
            session.add(profile)
            await session.flush()

        await session.commit()
        await session.refresh(profile)

    logger.info(
        "organizer/profiles/import: go_account=%s v2_profile=%s owner=%s created=%s",
        data.go_account_id, profile.id, owner_uuid, created,
    )
    return OrganizerProfileImportResponse(
        ok=True,
        v2_organizer_profile_id=str(profile.id),
        owner_v2_user_id=str(owner_uuid),
        created=created,
    )


class OrganizerTeamImportPayload(BaseModel):
    """go event_organizers → v2 organizer_team_members 이관.

    v2_event_id NULL → org-level 멤버십 (예: 1:N owner 케이스의 추가 owner)
    v2_event_id 있음 → event-level 멤버십 (host/coordinator/sponsor)
    """

    go_event_organizer_id: str
    v2_event_id: str | None = None
    v2_organizer_profile_id: str | None = None  # 위 profiles/import 결과
    #
    # 🔴 조직 소유자 대안 앵커 (2026-07-31 팀원 초대 복구).
    #
    # 종전엔 `v2_organizer_profile_id` 만 받았다. 그런데 go 의 초대 수락 경로는
    # 그 값을 **go `accounts` 테이블에서** 읽었고, 레벨2 컷오버로 그 테이블이
    # 비면서(0행) 조회가 0행 → 조용히 반환 → 멤버십이 아예 안 만들어졌다.
    #
    # 초대 행은 `account_id`(= go 세션 앵커)를 이미 갖고 있다. 그것을 그대로 넘기면
    # go 는 죽은 테이블을 안 봐도 된다. v2 가 `_resolve_organizer` 와 **같은 규칙**으로
    # 해석한다: User.id 우선, 없으면 OrganizerProfile.go_account_id (레거시 계정).
    #
    # 둘 중 **하나는** 있어야 한다(아래에서 검증).
    v2_organizer_ref: str | None = None
    v2_user_id: str
    role: str  # owner|manager|viewer (org-level) | host|coordinator|sponsor (event-level)
    display_order: int = 0


class OrganizerTeamImportResponse(BaseModel):
    ok: bool
    v2_team_member_id: str
    created: bool


@router.post(
    "/organizer/teams/import",
    response_model=OrganizerTeamImportResponse,
    summary="go → v2 organizer team member import",
)
async def import_organizer_team(request: Request):
    """go event_organizers → v2 organizer_team_members 이관.

    HMAC 검증 후 go_event_organizer_id 기준 upsert.
    organizer_id 는 v2_organizer_profile_id 의 owner user_id 로 자동 결정.
    """
    raw_body = await request.body()
    await verify_pickket_webhook(
        request,
        raw_body,
        settings.GO_WEBHOOK_SECRET,
        source="go",
        guard_replay=True,
    )

    try:
        data = OrganizerTeamImportPayload(**json.loads(raw_body))
    except Exception as exc:
        logger.warning("organizer/teams/import: invalid payload: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid payload: {exc}",
        ) from exc

    try:
        role_enum = TeamRole(data.role)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid role: {data.role}",
        )

    if not data.v2_organizer_profile_id and not data.v2_organizer_ref:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="v2_organizer_profile_id 또는 v2_organizer_ref 중 하나는 필요합니다",
        )
    try:
        event_uuid = uuid.UUID(data.v2_event_id) if data.v2_event_id else None
        profile_uuid = (
            uuid.UUID(data.v2_organizer_profile_id) if data.v2_organizer_profile_id else None
        )
        owner_ref_uuid = (
            uuid.UUID(data.v2_organizer_ref) if data.v2_organizer_ref else None
        )
        user_uuid = uuid.UUID(data.v2_user_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"UUID parse error: {exc}",
        )

    async with async_session() as session:
        # event 존재 확인 (event-level 일 때만)
        if event_uuid is not None:
            event_row = (
                await session.execute(select(Event.id).where(Event.id == event_uuid))
            ).scalar_one_or_none()
            if event_row is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"event not found: {data.v2_event_id}",
                )

        # 조직 소유자(organizer_id) 결정.
        #   ① v2_organizer_profile_id 가 오면 종전대로 프로필 → user_id
        #   ② v2_organizer_ref 가 오면 `_resolve_organizer` 와 **같은 규칙**으로 해석:
        #      User.id 우선, 없으면 OrganizerProfile.go_account_id (레거시 계정 앵커)
        owner_user_id: uuid.UUID | None = None
        if profile_uuid is not None:
            profile = (
                await session.execute(
                    select(OrganizerProfile).where(OrganizerProfile.id == profile_uuid)
                )
            ).scalar_one_or_none()
            if profile is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"organizer profile not found: {data.v2_organizer_profile_id}",
                )
            owner_user_id = profile.user_id
        else:
            owner_user_id = (
                await session.execute(
                    select(User.id).where(
                        User.id == owner_ref_uuid, User.is_organizer.is_(True)
                    )
                )
            ).scalar_one_or_none()
            if owner_user_id is None:
                # 레거시: go_account_id 앵커가 user_id 와 다른 계정
                owner_user_id = (
                    await session.execute(
                        select(OrganizerProfile.user_id).where(
                            OrganizerProfile.go_account_id == str(owner_ref_uuid)
                        )
                    )
                ).scalar_one_or_none()
            if owner_user_id is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"organizer not found: {data.v2_organizer_ref}",
                )

        # team member user 존재 확인 + invited_email 채우기 위해 fetch
        member_user = (
            await session.execute(select(User).where(User.id == user_uuid))
        ).scalar_one_or_none()
        if member_user is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"team member user not found: {data.v2_user_id}",
            )

        existing = (
            await session.execute(
                select(OrganizerTeamMember).where(
                    OrganizerTeamMember.go_event_organizer_id
                    == data.go_event_organizer_id
                )
            )
        ).scalar_one_or_none()

        created = existing is None
        if existing:
            tm = existing
            tm.organizer_id = owner_user_id
            tm.user_id = user_uuid
            tm.event_id = event_uuid
            tm.role = role_enum
            tm.display_order = data.display_order
            tm.invited_email = member_user.email
        else:
            tm = OrganizerTeamMember(
                organizer_id=owner_user_id,
                user_id=user_uuid,
                event_id=event_uuid,
                role=role_enum,
                display_order=data.display_order,
                invited_email=member_user.email,
                go_event_organizer_id=data.go_event_organizer_id,
            )
            session.add(tm)
            await session.flush()

        await session.commit()
        await session.refresh(tm)

    logger.info(
        "organizer/teams/import: go=%s v2_tm=%s event=%s user=%s role=%s created=%s",
        data.go_event_organizer_id, tm.id, event_uuid, user_uuid, role_enum.value, created,
    )
    return OrganizerTeamImportResponse(
        ok=True,
        v2_team_member_id=str(tm.id),
        created=created,
    )


# ── Settlement (Phase A) ──────────────────────────────────────────────────
# 피켓고가 organizer 대시보드 정산 row 자체 생성용으로 호출.
# organizer.py 의 /organizer/settlement 와 동일 계산 — 인증만 service token + organizer_id path.


class InternalSettlementSummary(BaseModel):
    organizer_id: str
    event_id: str | None = None
    gross_revenue: float
    platform_fee: float
    platform_fee_rate: float
    pg_fee: float
    pg_fee_rate: float
    net_settlement: float
    pending_refunds: float
    final_payout: float
    computed_at: str


@router.get(
    "/organizers/{organizer_id}/settlement",
    response_model=InternalSettlementSummary,
    summary="Internal: organizer 정산 요약 (피켓고 호출)",
    description=(
        "피켓고가 자체 settlements row 생성/갱신용으로 호출. "
        "X-Pickket-Service-Token 검증 + path organizer_id 기반. "
        "응답 구조는 /api/v1/organizer/settlement 와 동일 (값 1:1)."
    ),
)
async def internal_organizer_settlement(
    organizer_id: uuid.UUID,
    request: Request,
    event_id: uuid.UUID | None = None,
):
    # 인증: S-1(#23) 분리된 서비스 토큰 timing-safe 검증.
    _require_service_token(request)

    from sqlalchemy import func as F
    from app.models.order import Order, OrderStatus
    from app.models.refund import Refund, RefundStatus
    from app.services.finance_service import FinanceService

    async with async_session() as db:
        # organizer 존재 확인
        organizer = await db.execute(
            select(User.id, User.is_organizer).where(User.id == organizer_id)
        )
        org_row = organizer.first()
        if not org_row:
            raise HTTPException(status_code=404, detail="Organizer not found")
        if not org_row.is_organizer:
            raise HTTPException(status_code=403, detail="User is not an organizer")

        # event 소유권 확인 (event_id 지정 시)
        if event_id is not None:
            owned = (
                await db.execute(
                    select(Event.id).where(
                        Event.id == event_id,
                        Event.organizer_id == organizer_id,
                    )
                )
            ).scalar_one_or_none()
            if owned is None:
                raise HTTPException(
                    status_code=404, detail="Event not found or not owned by organizer"
                )

        finance_service = FinanceService(db)

        # 1) gross_revenue + platform_fee + pg_fee (paid orders 기반)
        # 기준: settlement_generate.py — net = gross - platform_fee - pg_fee - refunds.
        # 동결값 우선(order.platform_fee/pg_fee NOT NULL이면 그 값을 Decimal SUM),
        # NULL(4d 이전 주문)이면 get_fee_rates()로 재계산 fallback. 혼합 안전.
        paid_orders_q = await db.execute(
            select(Order, Event)
            .join(Event, Event.id == Order.event_id)
            .where(
                Event.organizer_id == organizer_id,
                Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
            )
        )
        paid_orders = paid_orders_q.all()
        if event_id is not None:
            paid_orders = [(o, e) for o, e in paid_orders if o.event_id == event_id]

        gross_revenue = Decimal("0")
        platform_fee = Decimal("0")
        pg_fee = Decimal("0")
        fee_cache: dict[tuple[str, str], tuple[float, float]] = {}
        for order, event in paid_orders:
            amount = Decimal(order.total_amount)
            gross_revenue += amount
            if order.platform_fee is not None and order.pg_fee is not None:
                # 동결값 사용 (4d-1 이후 주문)
                platform_fee += Decimal(order.platform_fee)
                pg_fee += Decimal(order.pg_fee)
            else:
                # fallback: 4d 이전 NULL 주문 → 요율 재계산
                cache_key = (str(order.event_id), str(event.organizer_id))
                if cache_key not in fee_cache:
                    fee_cache[cache_key] = await finance_service.get_fee_rates(
                        order.event_id, event.organizer_id
                    )
                p_rate, g_rate = fee_cache[cache_key]
                platform_fee += amount * Decimal(str(p_rate))
                pg_fee += amount * Decimal(str(g_rate))

        # 2) pending_refunds (Refund 테이블 기반)
        refund_q = (
            select(F.coalesce(F.sum(Refund.amount), 0.0))
            .select_from(Refund)
            .join(Order, Order.id == Refund.order_id)
            .join(Event, Event.id == Order.event_id)
            .where(
                Event.organizer_id == organizer_id,
                Refund.status.in_(
                    [
                        RefundStatus.PENDING,
                        RefundStatus.APPROVED,
                        RefundStatus.PROCESSING,
                        RefundStatus.COMPLETED,
                    ]
                ),
            )
        )
        if event_id is not None:
            refund_q = refund_q.where(Order.event_id == event_id)
        pending_refunds = Decimal((await db.execute(refund_q)).scalar() or 0)

        # 3) legacy REFUNDED orders (Refund row 없는 케이스)
        legacy_refund_q = (
            select(F.coalesce(F.sum(Order.total_amount), 0.0))
            .select_from(Order)
            .outerjoin(Refund, Refund.order_id == Order.id)
            .join(Event, Event.id == Order.event_id)
            .where(
                Event.organizer_id == organizer_id,
                Order.status == OrderStatus.REFUNDED,
                Refund.id.is_(None),
            )
        )
        if event_id is not None:
            legacy_refund_q = legacy_refund_q.where(Order.event_id == event_id)
        pending_refunds += Decimal(
            (await db.execute(legacy_refund_q)).scalar() or 0
        )

        # net = gross - platform_fee - pg_fee - refunds (settlement_generate.py 기준).
        # Money 컬럼 Numeric(12,2) 정밀도에 맞춰 quantize(Decimal('0.01')).
        _q = Decimal("0.01")
        gross_revenue = gross_revenue.quantize(_q)
        platform_fee = platform_fee.quantize(_q)
        pg_fee = pg_fee.quantize(_q)
        pending_refunds = pending_refunds.quantize(_q)
        net_settlement = gross_revenue - platform_fee - pg_fee
        final_payout = net_settlement - pending_refunds
        effective_fee_rate = (
            (platform_fee / gross_revenue) if gross_revenue > 0 else Decimal("0")
        )
        # P0 §4.1: go가 자체 settlements row에 분해값을 기록할 수 있도록 pg_fee 노출.
        # 계산엔 이미 반영(net = gross - platform_fee - pg_fee)되어 있었으나 응답 미노출
        # 이라 go가 net에서 역산하던 문제 종결.
        effective_pg_fee_rate = (
            (pg_fee / gross_revenue) if gross_revenue > 0 else Decimal("0")
        )

        return InternalSettlementSummary(
            organizer_id=str(organizer_id),
            event_id=str(event_id) if event_id else None,
            gross_revenue=float(gross_revenue),
            platform_fee=float(platform_fee),
            platform_fee_rate=round(float(effective_fee_rate), 4),
            pg_fee=float(pg_fee),
            pg_fee_rate=round(float(effective_pg_fee_rate), 4),
            net_settlement=float(net_settlement),
            pending_refunds=float(pending_refunds),
            final_payout=float(final_payout),
            computed_at=datetime.now(timezone.utc).isoformat(),
        )
