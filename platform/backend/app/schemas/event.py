import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator, model_validator

from app.models.event import EventStatus


def _category_to_public(value: str | None) -> str | None:
    return value.upper() if value else value


def _loaded_seat_tiers(data):
    """Return data.seat_tiers only if the relationship is actually loaded.

    Models use ``lazy="raise"`` on Event.seat_tiers, so a plain
    ``hasattr(data, "seat_tiers")`` raises ``InvalidRequestError`` (NOT
    AttributeError, so it is not swallowed) when the relationship was not
    eager-loaded. This helper treats an unloaded relationship as "absent" so
    serialization degrades gracefully instead of returning a 500.
    """
    from sqlalchemy.exc import InvalidRequestError
    from sqlalchemy.orm.exc import DetachedInstanceError

    try:
        return getattr(data, "seat_tiers", None)
    except (InvalidRequestError, DetachedInstanceError):
        return None


class EventCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    slug: str | None = Field(None, min_length=1, max_length=80, pattern=r"^[a-z0-9가-힣][a-z0-9가-힣\-]*$")
    description: str | None = Field(None, max_length=5000)
    venue: str = Field(min_length=1, max_length=200)
    venue_id: uuid.UUID | None = None
    event_date: datetime
    bidding_opens_at: datetime
    bidding_closes_at: datetime
    total_seats: int = Field(ge=1, le=500000)
    min_price: float = Field(ge=0, default=0.0)
    max_price: float | None = Field(ge=0, default=None)
    # Extended fields
    category: str = Field(default="CONCERT", max_length=50)
    sub_category: str | None = Field(None, max_length=50)
    image_url: str | None = Field(None, max_length=500)
    thumbnail_url: str | None = Field(None, max_length=500)
    location_city: str | None = Field(None, max_length=100)
    artist_name: str | None = Field(None, max_length=200)
    age_restriction: str | None = Field(None, max_length=20)
    tags: str | None = Field(None, max_length=500)
    # is_featured: admin-only — set server-side, not accepted from client
    duration_minutes: int | None = Field(ge=1, le=14400, default=None)
    is_public_sector: bool = False
    is_free: bool = False
    require_checkin: bool = False
    locality_restricted: str | None = Field(None, max_length=100)
    deposit_amount: float = Field(ge=0, default=0.0)
    no_show_policy: str = Field(default="refund", max_length=50)
    cancellation_fee_tiers: list[dict] | None = None
    discount_policies: list[dict] | dict | None = None
    resident_priority: bool = False
    resident_priority_days: int = Field(ge=0, le=365, default=7)
    nft_enabled: bool = False
    # Regulation
    price_cap_multiplier: float = Field(ge=1.0, le=10.0, default=2.0)
    require_identity_verification: bool = True
    # Remainder policy
    remainder_strategy: str = Field(default="discount_fcfs", max_length=50)
    remainder_trigger_hours: int = Field(ge=1, le=8760, default=72)
    remainder_step_interval_min: int = Field(ge=1, le=1440, default=60)
    # Multi-session
    multi_max_wins_per_user: int = Field(ge=1, le=100, default=2)
    multi_loser_bonus_weight: float = Field(ge=0, le=1.0, default=0.05)
    multi_cross_session_dedup: bool = True
    # Resale
    resale_enabled: bool = False
    resale_max_markup_pct: float = Field(ge=0, le=100, default=0.0)
    resale_royalty_pct: float = Field(ge=0, le=100, default=0.0)
    resale_opens_at: datetime | None = None
    resale_closes_at: datetime | None = None
    # Organizer portal fields
    age_rating: str | None = Field(None, max_length=20)
    seat_type: str = Field(default="assigned", max_length=20)
    seat_map_url: str | None = Field(None, max_length=500)
    allocation_ratio: float | None = Field(None, ge=0, le=100)
    delivery_method: str = Field(default="mobile", max_length=20)
    mobile_ticket_enabled: bool = True
    ticket_display_info: str | None = Field(None, max_length=2000)
    desired_open_date: datetime | None = None
    notice: str | None = Field(None, max_length=5000)
    description_images: str | None = Field(None, max_length=5000)
    participant_enabled: bool = False
    board_types: str | None = Field(None, max_length=500)
    event_date_end: datetime | None = None
    # Sports-specific fields
    home_team: str | None = Field(None, max_length=200)
    away_team: str | None = Field(None, max_length=200)
    match_status: str | None = Field(None, max_length=20)
    broadcast_url: str | None = Field(None, max_length=500)
    broadcast_platform: str | None = Field(None, max_length=100)
    parking_info: str | None = Field(None, max_length=5000)
    # Classical / Festival fields
    program_notes: str | None = None
    program_data: list[dict] | dict | None = None
    stage_info: str | None = None
    time_slot_enabled: bool = False
    time_slot_capacity: int | None = Field(ge=1, le=100000, default=None)
    time_slot_duration_minutes: int | None = Field(ge=15, le=1440, default=None)
    # Globalization
    currency: str = Field(default="KRW", max_length=3)
    event_timezone: str = Field(default="Asia/Seoul", max_length=50)
    # Missing model fields
    subject_name: str | None = Field(None, max_length=200)
    season_ticket_enabled: bool = False
    home_away_section: str | None = Field(None, max_length=20)
    resale_surplus_recapture_pct: float = Field(ge=0, le=100, default=60.0)
    # DICE+Laylo DNA
    brand_color: str | None = Field(None, max_length=9, pattern=r"^#[0-9A-Fa-f]{6,8}$")
    brand_color_fg: str | None = Field(None, max_length=9, pattern=r"^#[0-9A-Fa-f]{6,8}$")
    service_fee_rate: float = Field(ge=0, le=1.0, default=0.11)

    @field_validator("cancellation_fee_tiers", mode="before")
    @classmethod
    def validate_cancellation_fee_tiers(cls, v):
        if v is None:
            return v
        if not isinstance(v, list) or len(v) == 0:
            raise ValueError("cancellation_fee_tiers must be a non-empty list")
        for tier in v:
            if not isinstance(tier, dict):
                raise ValueError("Each tier must be a dict")
            if "days_before" not in tier or "fee_pct" not in tier:
                raise ValueError("Each tier must have 'days_before' and 'fee_pct'")
            days = tier["days_before"]
            pct = tier["fee_pct"]
            if not isinstance(days, (int, float)) or days < 0 or days > 365:
                raise ValueError(f"days_before must be 0-365, got {days}")
            if not isinstance(pct, (int, float)) or pct < 0 or pct > 100:
                raise ValueError(f"fee_pct must be 0-100, got {pct}")
        # Sort by days_before descending
        sorted_tiers = sorted(v, key=lambda x: x["days_before"], reverse=True)
        return sorted_tiers

    @model_validator(mode="after")
    def validate_prices(self):
        if self.max_price is not None and self.min_price is not None:
            if self.max_price < self.min_price:
                raise ValueError("max_price must be >= min_price")
        return self


class EventUpdate(BaseModel):
    title: str | None = Field(min_length=1, max_length=300, default=None)
    slug: str | None = Field(None, min_length=1, max_length=80, pattern=r"^[a-z0-9가-힣][a-z0-9가-힣\-]*$")
    description: str | None = Field(None, max_length=5000)
    venue: str | None = Field(min_length=1, max_length=200, default=None)
    venue_id: uuid.UUID | None = None
    event_date: datetime | None = None
    bidding_opens_at: datetime | None = None
    bidding_closes_at: datetime | None = None
    total_seats: int | None = Field(ge=1, le=500000, default=None)
    min_price: float | None = Field(ge=0, default=None)
    max_price: float | None = Field(ge=0, default=None)
    # Extended fields
    category: str | None = Field(None, max_length=50)
    sub_category: str | None = Field(None, max_length=50)
    image_url: str | None = Field(None, max_length=500)
    thumbnail_url: str | None = Field(None, max_length=500)
    location_city: str | None = Field(None, max_length=100)
    artist_name: str | None = Field(None, max_length=200)
    age_restriction: str | None = Field(None, max_length=20)
    tags: str | None = Field(None, max_length=500)
    # is_featured: admin-only — set server-side, not accepted from client
    duration_minutes: int | None = Field(ge=1, le=14400, default=None)
    is_public_sector: bool | None = None
    is_free: bool | None = None
    require_checkin: bool | None = None
    locality_restricted: str | None = Field(None, max_length=100)
    deposit_amount: float | None = Field(ge=0, default=None)
    no_show_policy: str | None = Field(None, max_length=50)
    cancellation_fee_tiers: list[dict] | None = None
    discount_policies: list[dict] | dict | None = None
    resident_priority: bool | None = None
    resident_priority_days: int | None = Field(ge=0, le=365, default=None)
    nft_enabled: bool | None = None
    price_cap_multiplier: float | None = Field(ge=1.0, le=10.0, default=None)
    require_identity_verification: bool | None = None
    remainder_strategy: str | None = Field(None, max_length=50)
    remainder_trigger_hours: int | None = Field(ge=1, le=8760, default=None)
    remainder_step_interval_min: int | None = Field(ge=1, le=1440, default=None)
    multi_max_wins_per_user: int | None = Field(ge=1, le=100, default=None)
    multi_loser_bonus_weight: float | None = Field(ge=0, le=1.0, default=None)
    multi_cross_session_dedup: bool | None = None
    resale_enabled: bool | None = None
    resale_max_markup_pct: float | None = Field(ge=0, le=100, default=None)
    resale_royalty_pct: float | None = Field(ge=0, le=100, default=None)
    resale_opens_at: datetime | None = None
    resale_closes_at: datetime | None = None
    # Organizer portal fields
    age_rating: str | None = Field(None, max_length=20)
    seat_type: str | None = Field(None, max_length=20)
    seat_map_url: str | None = Field(None, max_length=500)
    allocation_ratio: float | None = Field(None, ge=0, le=100)
    delivery_method: str | None = Field(None, max_length=20)
    mobile_ticket_enabled: bool | None = None
    ticket_display_info: str | None = Field(None, max_length=2000)
    desired_open_date: datetime | None = None
    notice: str | None = Field(None, max_length=5000)
    description_images: str | None = Field(None, max_length=5000)
    participant_enabled: bool | None = None
    board_types: str | None = Field(None, max_length=500)
    event_date_end: datetime | None = None
    # Sports-specific fields
    home_team: str | None = Field(None, max_length=200)
    away_team: str | None = Field(None, max_length=200)
    match_status: str | None = Field(None, max_length=20)
    broadcast_url: str | None = Field(None, max_length=500)
    broadcast_platform: str | None = Field(None, max_length=100)
    parking_info: str | None = Field(None, max_length=5000)
    # Classical / Festival fields
    program_notes: str | None = None
    program_data: list[dict] | dict | None = None
    stage_info: str | None = None
    time_slot_enabled: bool | None = None
    time_slot_capacity: int | None = Field(ge=1, le=100000, default=None)
    time_slot_duration_minutes: int | None = Field(ge=15, le=1440, default=None)
    # Globalization
    currency: str | None = Field(None, max_length=3)
    event_timezone: str | None = Field(None, max_length=50)
    # DICE+Laylo DNA
    brand_color: str | None = Field(None, max_length=9, pattern=r"^#[0-9A-Fa-f]{6,8}$")
    brand_color_fg: str | None = Field(None, max_length=9, pattern=r"^#[0-9A-Fa-f]{6,8}$")
    service_fee_rate: float | None = Field(None, ge=0, le=1.0)

    @field_validator("cancellation_fee_tiers", mode="before")
    @classmethod
    def validate_cancellation_fee_tiers(cls, v):
        if v is None:
            return v
        if not isinstance(v, list) or len(v) == 0:
            raise ValueError("cancellation_fee_tiers must be a non-empty list")
        for tier in v:
            if not isinstance(tier, dict):
                raise ValueError("Each tier must be a dict")
            if "days_before" not in tier or "fee_pct" not in tier:
                raise ValueError("Each tier must have 'days_before' and 'fee_pct'")
            days = tier["days_before"]
            pct = tier["fee_pct"]
            if not isinstance(days, (int, float)) or days < 0 or days > 365:
                raise ValueError(f"days_before must be 0-365, got {days}")
            if not isinstance(pct, (int, float)) or pct < 0 or pct > 100:
                raise ValueError(f"fee_pct must be 0-100, got {pct}")
        # Sort by days_before descending
        sorted_tiers = sorted(v, key=lambda x: x["days_before"], reverse=True)
        return sorted_tiers

    @model_validator(mode="after")
    def validate_prices(self):
        if self.max_price is not None and self.min_price is not None:
            if self.max_price < self.min_price:
                raise ValueError("max_price must be >= min_price")
        return self


class EventListItem(BaseModel):
    """Lightweight DTO for list views — only essential fields for cards/grids."""

    id: uuid.UUID
    title: str
    slug: str
    image_url: str | None = None
    # 카드(EventCard)가 thumb 렌디션을 쓰도록 노출 — 없으면 마스터 WebP 로 폴백(대역폭/LCP 손해).
    # Event 모델에 컬럼 존재 → from_attributes 로 자동 채워짐.
    image_variants: dict | None = None
    venue: str | None = None
    event_date: datetime
    category: str | None = None
    status: str
    min_price: float | None = None
    bid_count: int = 0
    is_featured: bool = False
    organizer_name: str | None = None
    location_city: str | None = None
    thumbnail_url: str | None = None
    primary_sale_mode: str | None = None
    service_fee_rate: float = 0.11
    # 매진 표시용 — 모든 tier 의 sold_count/capacity 합계
    sold_count: int = 0
    total_capacity: int = 0
    is_sold_out: bool = False

    model_config = ConfigDict(from_attributes=True)

    @field_serializer("category")
    def serialize_category(self, value: str | None) -> str | None:
        return _category_to_public(value)

    @model_validator(mode="before")
    @classmethod
    def extract_sale_mode(cls, data):
        """Extract dominant sale_mode + sold/capacity aggregates from seat_tiers."""
        # OUR _loaded_seat_tiers() guards against unloaded SQLAlchemy relationships
        # (avoids lazy-load errors); 민성's sold/capacity aggregation kept on top.
        tiers = _loaded_seat_tiers(data)
        if tiers:
            # Pick the sale_mode of the tier with the highest capacity
            best = max(tiers, key=lambda t: t.capacity)
            sold_sum = sum(int(t.sold_count or 0) for t in tiers)
            cap_sum = sum(int(t.capacity or 0) for t in tiers)
            if hasattr(data, "__dict__"):
                data.__dict__["primary_sale_mode"] = best.sale_mode
                data.__dict__["sold_count"] = sold_sum
                data.__dict__["total_capacity"] = cap_sum
                data.__dict__["is_sold_out"] = cap_sum > 0 and sold_sum >= cap_sum
        return data


class EventListItemResponse(BaseModel):
    """Paginated list wrapper using lightweight EventListItem."""

    events: list[EventListItem]
    total: int


class EventSummaryResponse(BaseModel):
    """Public-safe event payload used by list/search/ranking endpoints."""

    id: uuid.UUID
    title: str
    slug: str
    description: str | None = None
    # 한 줄 요약(Phase 1-S) — 리스트/검색 카드에도 안전하게 노출(NULL 허용).
    summary: str | None = None
    venue: str
    event_date: datetime
    bidding_opens_at: datetime
    bidding_closes_at: datetime
    total_seats: int
    min_price: float
    max_price: float | None = None
    status: EventStatus
    category: str = "CONCERT"
    sub_category: str | None = None
    image_url: str | None = None
    thumbnail_url: str | None = None
    location_city: str | None = None
    artist_name: str | None = None
    subject_name: str | None = None
    age_restriction: str | None = None
    tags: str | None = None
    is_featured: bool = False
    bid_count: int = 0
    view_count: int = 0
    is_public_sector: bool = False
    is_free: bool = False
    deposit_amount: float = 0.0
    resident_priority: bool = False
    resident_priority_days: int = 7
    nft_enabled: bool = False
    duration_minutes: int | None = None
    event_date_end: datetime | None = None
    participant_enabled: bool = False
    currency: str = "KRW"
    event_timezone: str = "Asia/Seoul"
    home_team: str | None = None
    away_team: str | None = None
    match_status: str | None = None
    broadcast_url: str | None = None
    broadcast_platform: str | None = None
    parking_info: str | None = None
    program_notes: str | None = None
    program_data: list[dict] | dict | None = None
    stage_info: str | None = None
    time_slot_enabled: bool = False
    time_slot_capacity: int | None = None
    time_slot_duration_minutes: int | None = None
    blurhash: str | None = None
    image_variants: dict | None = None
    gallery_images: list | None = None
    service_fee_rate: float = 0.11

    model_config = {"from_attributes": True}

    @field_serializer("category")
    def serialize_category(self, value: str) -> str:
        return _category_to_public(value) or value


class EventParticipantOut(BaseModel):
    """go 미러 출연진 노출 (단계5)."""
    name: str
    role: str | None = None
    bio: str | None = None
    image_url: str | None = None
    sort_order: int = 0
    model_config = {"from_attributes": True}


class EventAnnouncementOut(BaseModel):
    """go 미러 공지 노출 (단계5)."""
    notice_type: str | None = None
    title: str
    content: str | None = None
    published_at: datetime | None = None
    model_config = {"from_attributes": True}


class EventFacilityOut(BaseModel):
    """go 미러 시설 노출 (단계5)."""
    name: str
    category: str | None = None
    quantity: int | None = None
    status: str | None = None
    model_config = {"from_attributes": True}


class EventResponse(BaseModel):
    id: uuid.UUID
    organizer_id: uuid.UUID
    title: str
    slug: str
    description: str | None
    venue: str
    venue_id: uuid.UUID | None = None
    event_date: datetime
    bidding_opens_at: datetime
    bidding_closes_at: datetime
    total_seats: int
    min_price: float
    max_price: float | None
    status: EventStatus
    # 판매중지 플래그 — go 에서 판매중지 시 status 는 유지되고 이 불리언만 true.
    # 소비자 상세가 예매 CTA 를 '판매중지'로 전환하도록 노출(없으면 결제단계서야 차단).
    sales_paused: bool = False
    created_at: datetime
    # Extended fields
    category: str = "CONCERT"
    sub_category: str | None = None
    image_url: str | None = None
    thumbnail_url: str | None = None
    location_city: str | None = None
    artist_name: str | None = None
    subject_name: str | None = None
    community_id: uuid.UUID | None = None
    age_restriction: str | None = None
    tags: str | None = None
    is_featured: bool = False
    bid_count: int = 0
    view_count: int = 0
    duration_minutes: int | None = None
    is_public_sector: bool = False
    is_free: bool = False
    require_checkin: bool = False
    # 나이스 카드전용 게이팅(C1) — 허용 결제수단 화이트리스트(정규화 대문자).
    # NULL=전체 허용(무제한). ["CARD"]=카드전용 등. consumer/organizer 가 이 값으로
    # 결제수단 선택지를 제한한다(서버도 prepare 에서 동일 강제 — 우회 불가).
    allowed_pay_methods: list[str] | None = None
    locality_restricted: str | None = None
    deposit_amount: float = 0.0
    no_show_policy: str = "refund"
    cancellation_fee_tiers: list[dict] | None = None
    discount_policies: list[dict] | dict | None = None
    resident_priority: bool = False
    resident_priority_days: int = 7
    nft_enabled: bool = False
    price_cap_multiplier: float = 2.0
    require_identity_verification: bool = True
    remainder_strategy: str = "discount_fcfs"
    remainder_trigger_hours: int = 72
    remainder_step_interval_min: int = 60
    multi_max_wins_per_user: int = 2
    multi_loser_bonus_weight: float = 0.05
    multi_cross_session_dedup: bool = True
    resale_enabled: bool = False
    resale_max_markup_pct: float = 0.0
    resale_royalty_pct: float = 0.0
    resale_opens_at: datetime | None = None
    resale_closes_at: datetime | None = None
    # Organizer portal fields
    age_rating: str | None = None
    # 상세페이지 통합 트랙B U1 — go→v2 흡수, NULL 시 소비자 상세 미노출(비파괴).
    venue_address: str | None = None  # 공연장 주소
    # 지도 API 연동 — 주최사가 「장소 찾기」로 고른 좌표. 둘 다 있을 때만 소비자 상세가 지도를 그린다.
    venue_lat: float | None = None
    venue_lng: float | None = None
    is_online: bool = False  # 온라인 이벤트 여부
    homepage_url: str | None = None  # 공식 홈페이지
    # 상세페이지 통합 트랙B U3 공개 랜딩 부속기능 게이트 — go→v2 흡수, from_attributes 자동 매핑.
    # consumer 가 이 플래그로 RSVP/단체예약 폼 노출 여부를 판정한다(false 시 미노출).
    rsvp_enabled: bool = False
    group_booking_enabled: bool = False
    # 주최자 수동 상단 배너 문구. NULL 시 consumer 는 자동 배너(D-day/재고)로 폴백.
    context_banner: str | None = None
    seat_type: str = "assigned"
    seat_map_url: str | None = None
    # 좌석 배치도 원본 canvas (Phase 1-Map) — go→v2 흡수, NULL 시 소비자는 seat_map_url 폴백.
    # {version, maps:[{id,name,status,floor_index,floor_label,parent_map_id, map_data, background, landmarks}]}
    # 레벨2 3차 3.1 — 소비자 격리: draft 계약으로 draft 맵도 원본에 담기므로, 소비자 응답에서는
    # published 맵만 노출한다(draft 공개 누출 0). 아래 validator 가 강제(마켓 상세 EventResponse 경계).
    seat_map_data: dict | None = None

    @field_validator("seat_map_data", mode="before")
    @classmethod
    def _publish_only_seat_map_data(cls, value):
        from app.core.seat_map import published_seat_map_data

        return published_seat_map_data(value)
    allocation_ratio: float | None = None
    delivery_method: str = "mobile"
    mobile_ticket_enabled: bool = True
    ticket_display_info: str | None = None
    desired_open_date: datetime | None = None
    notice: str | None = None
    description_images: str | None = None
    participant_enabled: bool = False
    board_types: str | None = None
    event_date_end: datetime | None = None
    # 게스트(비회원) 체크아웃 opt-in (상세통합 S2a·§8.2) — go→v2 흡수, from_attributes 자동 매핑.
    # consumer 가 이 플래그로 게스트 구매 게이트를 발화한다(false 시 회원 로그인만 노출).
    # guest_checkout_channels 는 게스트 허용 sale_mode 화이트리스트(예: ['fixed_fcfs','free']).
    # NULL=플래그만으로 판단. consumer 가 sale_mode 별 게이트 필터에 사용(옵션).
    guest_checkout_enabled: bool = False
    guest_checkout_channels: list[str] | None = None
    # 상세페이지 통합 갭 필드 (Phase 1-S) — go→v2 흡수, NULL 시 소비자 상세 미노출.
    summary: str | None = None  # 한 줄 요약
    event_schedules: list[dict] | None = None  # [{time, title, description}]
    seo_metadata: dict | None = None  # {title, description, keywords, og_image}
    questions: list[dict] | None = None  # [{label, type, required, options}]
    transport_info: str | None = None  # 오시는 길(parking_info 는 아래 스포츠 필드에 기존재)
    runtime_minutes: int | None = None
    intermission_minutes: int | None = None
    # Sports-specific fields
    home_team: str | None = None
    away_team: str | None = None
    match_status: str | None = None
    broadcast_url: str | None = None
    broadcast_platform: str | None = None
    parking_info: str | None = None
    # Classical / Festival fields
    program_notes: str | None = None
    program_data: list[dict] | dict | None = None
    stage_info: str | None = None
    time_slot_enabled: bool = False
    time_slot_capacity: int | None = None
    time_slot_duration_minutes: int | None = None
    organizer_name: str | None = None
    organizer_contact_email: str | None = None
    organizer_contact_phone: str | None = None
    blurhash: str | None = None
    image_variants: dict | None = None
    gallery_images: list | None = None
    # Globalization
    currency: str = "KRW"
    event_timezone: str = "Asia/Seoul"
    # DICE+Laylo DNA
    brand_color: str | None = None
    brand_color_fg: str | None = None
    service_fee_rate: float = 0.11
    # Seat tiers (loaded via relationship)
    seat_tiers: list["SeatTierResponseCompact"] = []
    primary_sale_mode: str | None = None
    # 매진 표시용 — 전체 tier sold_count/capacity 합계 (EventListItem과 동일하게 상세에도 노출)
    sold_count: int = 0
    total_capacity: int = 0
    is_sold_out: bool = False
    # go 미러 (단계5 — 소비자 노출). event detail 핸들러에서 별도 쿼리로 주입.
    participants: list["EventParticipantOut"] = []
    announcements: list["EventAnnouncementOut"] = []
    facilities: list["EventFacilityOut"] = []

    model_config = {"from_attributes": True}

    @field_serializer("category")
    def serialize_category(self, value: str) -> str:
        return _category_to_public(value) or value

    @model_validator(mode="before")
    @classmethod
    def extract_sale_mode(cls, data):
        tiers = _loaded_seat_tiers(data)
        if tiers:
            best = max(tiers, key=lambda t: t.capacity)
            sold_sum = sum(int(t.sold_count or 0) for t in tiers)
            cap_sum = sum(int(t.capacity or 0) for t in tiers)
            if hasattr(data, "__dict__"):
                data.__dict__["primary_sale_mode"] = best.sale_mode
                data.__dict__["sold_count"] = sold_sum
                data.__dict__["total_capacity"] = cap_sum
                data.__dict__["is_sold_out"] = cap_sum > 0 and sold_sum >= cap_sum
        return data


class SeatTierResponseCompact(BaseModel):
    id: uuid.UUID
    name: str
    capacity: int
    base_price: float
    sale_mode: str
    face_price: float
    sold_count: int = 0
    remaining: int = 0
    min_price: float = 0

    @model_validator(mode="after")
    def _compute_remaining(self) -> "SeatTierResponseCompact":
        if self.remaining == 0 and self.capacity > 0:
            self.remaining = max(0, self.capacity - self.sold_count)
        return self
    max_price_cap: float = 0
    lottery_application_hours: int = 48
    seating_type: str = "assigned"
    bidding_opens_at: datetime | None = None
    bidding_closes_at: datetime | None = None

    model_config = {"from_attributes": True}


# Update forward ref
EventResponse.model_rebuild()


class EventListResponse(BaseModel):
    events: list[EventSummaryResponse]
    total: int


class EventSearchParams(BaseModel):
    q: str | None = Field(None, max_length=200)
    category: str | None = Field(None, max_length=50)
    sub_category: str | None = Field(None, max_length=50)
    city: str | None = Field(None, max_length=100)
    date_from: datetime | None = None
    date_to: datetime | None = None
    price_min: float | None = Field(None, ge=0)
    price_max: float | None = Field(None, ge=0)
    status: str | None = Field(None, max_length=30)
    is_public_sector: bool | None = None
    sort: str = Field(default="newest", max_length=20)  # popular|newest|price_asc|price_desc|date
    skip: int = Field(default=0, ge=0)
    limit: int = Field(default=20, ge=1, le=100)


class PriceAdviceResponse(BaseModel):
    event_id: uuid.UUID
    competition_level: float
    avg_historical_price: float | None
    fan_weight: float
    weight_percentile: float
    estimated_win_probability: float
    suggested_min_bid: float
    suggested_max_bid: float
    suggestion_text: str


class CategoryCount(BaseModel):
    category: str
    count: int

    @field_serializer("category")
    def serialize_category(self, value: str) -> str:
        return _category_to_public(value) or value


class FavoriteResponse(BaseModel):
    event_id: uuid.UUID
    is_favorited: bool


class GenerateTimeSlotsRequest(BaseModel):
    """Request body for auto-generating exhibition time slots."""

    start_hour: int = Field(ge=0, le=23)
    end_hour: int = Field(ge=1, le=24)
    interval_minutes: int = Field(default=60, ge=15, le=180)
    capacity_per_slot: int = Field(default=50, ge=1)

    @model_validator(mode="after")
    def validate_hours(self):
        if self.end_hour <= self.start_hour:
            raise ValueError("end_hour must be greater than start_hour")
        return self


class TimeSlotAvailabilityItem(BaseModel):
    start: datetime
    end: datetime
    available: int
    total: int


class TimeSlotAvailabilityResponse(BaseModel):
    slots: list[TimeSlotAvailabilityItem]


class EventOpenResponse(BaseModel):
    """Lightweight payload for /e/<slug> landing page (DICE+Laylo DNA)."""

    id: uuid.UUID
    slug: str
    title: str
    venue: str
    venue_id: uuid.UUID | None = None
    image_url: str | None = None
    image_variants: dict | None = None
    gallery_images: list | None = None
    thumbnail_url: str | None = None
    event_date: datetime
    ticket_open_at: datetime | None = None  # = desired_open_date
    brand_color: str | None = None  # fallback #FF3366
    brand_color_fg: str | None = None  # fallback #FFFFFF
    category: str = "CONCERT"
    artist_name: str | None = None
    location_city: str | None = None
    status: str
    service_fee_rate: float = 0.11
    subscriber_count: int = 0  # injected from event_open_subscriptions count

    model_config = {"from_attributes": True}

    @field_serializer("category")
    def serialize_category(self, value: str) -> str:
        return _category_to_public(value) or value
