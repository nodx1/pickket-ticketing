import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    String,
    Integer,
    DateTime,
    Float,
    ForeignKey,
    Enum,
    Text,
    Boolean,
    Index,
    JSON,
    Numeric,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates

from app.core.database import Base
from app.models.types import Money

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class EventStatus(str, PyEnum):
    DRAFT = "draft"
    PENDING_REVIEW = "pending_review"
    UNDER_REVIEW = "under_review"
    REVISION_REQUESTED = "revision_requested"
    APPROVED = "approved"
    BIDDING_OPEN = "bidding_open"
    BIDDING_CLOSED = "bidding_closed"
    ALLOCATING = "allocating"
    ALLOCATED = "allocated"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        Index("idx_event_status_date", "status", "event_date"),
        Index("idx_events_status_created_at", "status", "created_at"),
        Index("idx_events_city_event_date", "location_city", "event_date"),
        # WP-3: Featured events lookup
        Index("idx_event_featured", "is_featured", "created_at"),
        # WP-5: FK index for organizer lookups
        Index("idx_event_organizer", "organizer_id"),
        # A1: /e/<slug> — unique+index는 mapped_column에서 생성
        # NOTE: idx_event_fts (GIN to_tsvector) is PostgreSQL-only and suppressed
        # in alembic/env.py include_object (not declared here).
        # DB reconcile: 기존 DB 인덱스 모델 선언 동기화
        Index("idx_events_sale_channels_gin", "sale_channels", postgresql_using="gin"),
        Index("ix_events_category_status", "category", "status"),
        Index("ix_events_event_date", "event_date"),
        # SPEC §1.6 — go event id ↔ v2 canonical id 매핑(write-through 멱등 upsert).
        # NULL 다중 허용(기존 v2-네이티브 이벤트는 external_ref 없음).
        Index("ix_events_external_ref", "external_ref", unique=True),
        CheckConstraint(
            "bidding_closes_at > bidding_opens_at",
            name="ck_events_bidding_window",
        ),
        CheckConstraint("total_seats > 0", name="ck_events_total_seats_positive"),
        CheckConstraint("bid_count >= 0", name="ck_events_bid_count_nonneg"),
        CheckConstraint("view_count >= 0", name="ck_events_view_count_nonneg"),
        CheckConstraint(
            "category IN ('concert','musical','sports','classical','exhibition','festival','esports','education','civic')",
            name="ck_events_category_valid",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    slug: Mapped[str] = mapped_column(String(80), nullable=False, unique=True, index=True)
    # go write-through 매핑 키 (go event id). v2-네이티브 이벤트는 NULL.
    external_ref: Mapped[str | None] = mapped_column(String(100), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    venue: Mapped[str] = mapped_column(String(200), nullable=False)
    event_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # Batch window
    bidding_opens_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    bidding_closes_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    total_seats: Mapped[int] = mapped_column(Integer, nullable=False)
    min_price: Mapped[Decimal] = mapped_column(Money, default=0.0)
    max_price: Mapped[Decimal | None] = mapped_column(Money, nullable=True)

    # Extended fields
    category: Mapped[str] = mapped_column(String(50), nullable=False, default="concert", index=True)
    sub_category: Mapped[str | None] = mapped_column(String(50), nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # go가 보내는 렌디션 맵: wide(16:9)/portrait(3:4)/thumb(4:3)/og(1200x630) → 절대 URL
    image_variants: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    # go가 보내는 갤러리(최대 4장): [{url, variants:{wide,portrait,thumb,og}|null}] — 소비자 캐러셀 렌더
    gallery_images: Mapped[list | None] = mapped_column(_JSON_TYPE, nullable=True)
    thumbnail_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    location_city: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    artist_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    age_restriction: Mapped[str | None] = mapped_column(String(20), nullable=True)
    tags: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON array string
    is_featured: Mapped[bool] = mapped_column(Boolean, default=False)
    # go "paused"(주최자 판매 일시중지) — status-독립 on/off. status를 건드리지 않아
    # 재개=플래그 해제로 직전 상태(bidding_open 등) 그대로 복원. read 투영 시
    # sales_paused=True + go투영=="live" → "paused"로 노출(라운드트립).
    sales_paused: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    # 판매 채널 — go에서 관리: ['self'] 기본, ['self','marketplace']는 v2 consumer 노출
    # PG ARRAY 기본 + SQLite JSON variant (테스트 호환)
    # 순서 중요: 기본을 ARRAY로 해야 .contains() 가 PG ARRAY 연산자 생성 (JSON LIKE 아님)
    sale_channels: Mapped[list[str]] = mapped_column(
        ARRAY(Text).with_variant(JSON(), "sqlite"),
        server_default="{self,marketplace}",
        default=lambda: ["self", "marketplace"],
        nullable=False,
    )
    # 상세통합 S2a(§2.2·§8.2): 게스트(비회원) 체크아웃 opt-in 게이트.
    # 미설정 시 false → 게스트 주문 차단(_do_create_order sales_paused 직후 게이트).
    guest_checkout_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    # 게스트 허용 채널 화이트리스트(예: ['fixed_fcfs','free']). NULL=플래그만으로 판단.
    # point_lottery 등 회원전용 로직은 이 화이트리스트로 게스트 배제(§6.3).
    guest_checkout_channels: Mapped[list[str] | None] = mapped_column(
        _JSON_TYPE, nullable=True
    )
    bid_count: Mapped[int] = mapped_column(Integer, default=0)
    view_count: Mapped[int] = mapped_column(Integer, default=0)
    duration_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)

    status: Mapped[EventStatus] = mapped_column(
        Enum(EventStatus, values_callable=lambda e: [x.value for x in e], native_enum=False, length=30),
        default=EventStatus.DRAFT,
        nullable=False,
    )

    # Community / subject link
    community_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("fanclubs.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    subject_name: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # --- Organizer portal extended fields ---
    age_rating: Mapped[str | None] = mapped_column(String(20), nullable=True)  # 전체/12세/15세/19세
    # --- 상세페이지 통합 트랙B U1 (go→v2 write-through 정본) ---
    # go events 에만 있고 v2 미배선이던 핵심 상세 필드. nullable 가산·비파괴.
    # 소비자 상세는 NULL 시 해당 섹션 미노출(계약 무변).
    venue_address: Mapped[str | None] = mapped_column(Text, nullable=True)  # go venue_address — 공연장 주소
    # 지도 API 연동(과업지시서 2-1) — 「장소 찾기」로 고른 장소의 좌표. 둘 다 있거나 둘 다 NULL(마이그 gwasup07).
    venue_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    venue_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    # 온라인 이벤트 여부. server_default false → 기존 행 안전(비파괴).
    is_online: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    homepage_url: Mapped[str | None] = mapped_column(String(500), nullable=True)  # go homepage_url — 공식 홈페이지
    # --- 상세페이지 통합 트랙B U3 (공개 랜딩 부속기능, go→v2 write-through 정본) ---
    # 주최자 opt-in 게이트. server_default false → 기존 행 안전(비파괴).
    # rsvp_enabled: 무료 참석(RSVP) 폼 노출·수신 허용.
    rsvp_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    # group_booking_enabled: 단체 예약 문의 폼 노출·수신 허용.
    group_booking_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    # context_banner: 주최자가 go 에서 설정하는 수동 상단 배너 문구(공지/프로모션 등).
    # NULL 시 consumer 는 event_date/재고 기반 자동 배너로 폴백(계약 무변).
    context_banner: Mapped[str | None] = mapped_column(Text, nullable=True)
    seat_type: Mapped[str] = mapped_column(String(20), default="assigned")  # assigned/unassigned
    seat_map_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # --- 좌석 배치도 원본 canvas (Phase 1-Map, go→v2 write-through 정본) ---
    # go seat_maps.map_data(canvas JSON) + background/floor/landmarks 를 병합한 렌더용 원본.
    # v2 는 seat_map_url(썸네일 URL)만 갖고 있어 소비자가 좌석 배치도를 원본 렌더할 수 없었음(census 0-C).
    # 형태(계약, 소비자 소비용): {version, maps:[{id,name,status,floor_index,floor_label,parent_map_id,
    #   map_data, background:{url,opacity,width,height}|null, landmarks:[...]}]}
    # map_data 는 go 원본을 변환 없이 그대로 보관. nullable — 비지정석/미발행 이벤트는 NULL(비파괴).
    seat_map_data: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    allocation_ratio: Mapped[float | None] = mapped_column(Float, nullable=True)  # 0-100
    delivery_method: Mapped[str] = mapped_column(
        String(20), default="mobile"
    )  # mobile/onsite/delivery
    mobile_ticket_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    ticket_display_info: Mapped[str | None] = mapped_column(Text, nullable=True)
    desired_open_date: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    notice: Mapped[str | None] = mapped_column(Text, nullable=True)
    description_images: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )  # JSON array of URLs
    participant_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    board_types: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )  # JSON array: ["review","expectation","qna"]
    event_date_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # --- 상세페이지 통합 갭 필드 (Phase 1-S, go→v2 write-through 정본) ---
    # go 에만 있던 필드를 nullable 가산으로 흡수. 1-O 가 write-through 로 채운다.
    # 기존 행은 전부 NULL(비파괴). 소비자 상세는 NULL 시 해당 섹션 미노출.
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)  # go summary — 한 줄 요약
    # go schedules — 타임테이블 배열 [{time, title, description}]
    event_schedules: Mapped[list | None] = mapped_column(_JSON_TYPE, nullable=True)
    # go seoMetadata — {title, description, keywords, og_image}
    seo_metadata: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    # go questions — 예매 설문 배열 [{label, type, required, options}]
    questions: Mapped[list | None] = mapped_column(_JSON_TYPE, nullable=True)
    # go transportInfo — 오시는 길(대중교통 등). parking_info(주차)는 기존 컬럼 재사용.
    transport_info: Mapped[str | None] = mapped_column(Text, nullable=True)
    # go runtimeMinutes / intermissionMinutes — 공연 러닝타임·인터미션(분).
    runtime_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    intermission_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Sports-specific fields
    home_team: Mapped[str | None] = mapped_column(String(200), nullable=True)
    away_team: Mapped[str | None] = mapped_column(String(200), nullable=True)
    match_status: Mapped[str | None] = mapped_column(
        String(20), nullable=True
    )  # scheduled/live/finished
    broadcast_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    broadcast_platform: Mapped[str | None] = mapped_column(String(100), nullable=True)
    parking_info: Mapped[str | None] = mapped_column(Text, nullable=True)
    season_ticket_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    home_away_section: Mapped[str | None] = mapped_column(
        String(20), nullable=True
    )  # home/away/neutral

    # Classical / Festival fields
    program_notes: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )  # Classical: concert program/repertoire
    program_data: Mapped[dict | None] = mapped_column(
        JSON, nullable=True
    )  # Classical: structured program pieces
    stage_info: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )  # Festival: stage layout/lineup info

    # Exhibition / Festival: time-slot entry
    time_slot_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    time_slot_capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    time_slot_duration_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Phase & session
    current_phase: Mapped[str] = mapped_column(String(50), default="setup")
    artist_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    session_number: Mapped[int] = mapped_column(Integer, default=1)
    tour_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    # Venue link
    venue_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("venues.id", ondelete="SET NULL"), nullable=True
    )

    # Regulation
    price_cap_multiplier: Mapped[float] = mapped_column(Float, default=2.0)
    require_identity_verification: Mapped[bool] = mapped_column(Boolean, default=True)

    # Remainder policy
    remainder_strategy: Mapped[str] = mapped_column(String(50), default="discount_fcfs")
    remainder_trigger_hours: Mapped[int] = mapped_column(Integer, default=72)
    remainder_step_interval_min: Mapped[int] = mapped_column(Integer, default=60)

    # Multi-session
    multi_max_wins_per_user: Mapped[int] = mapped_column(Integer, default=2)
    multi_loser_bonus_weight: Mapped[float] = mapped_column(Float, default=0.05)
    multi_cross_session_dedup: Mapped[bool] = mapped_column(Boolean, default=True)

    # Transfer & Resale
    is_transferable: Mapped[bool] = mapped_column(Boolean, default=True)
    resale_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    resale_max_markup_pct: Mapped[float] = mapped_column(Float, default=0.0)
    resale_royalty_pct: Mapped[float] = mapped_column(Float, default=0.0)
    resale_surplus_recapture_pct: Mapped[float] = mapped_column(Float, default=60.0)
    resale_opens_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resale_closes_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Globalization: multi-currency & timezone
    currency: Mapped[str] = mapped_column(String(3), default="KRW", nullable=False)
    event_timezone: Mapped[str] = mapped_column(String(50), default="Asia/Seoul", nullable=False)

    # F1 다일 입장 규칙 (CHECKIN-STATE-CONTRACT-F1 §3).
    # single(기존): 단일일 이벤트, 입장 1회→USED (동작 불변).
    # daypass: 지정/선택 1일권, 해당일 입장→USED.
    # allpass: 전일권, event_date~event_date_end 매일 입장, ACTIVE 유지.
    admission_mode: Mapped[str] = mapped_column(
        String(20), default="single", server_default=text("'single'"), nullable=False
    )

    # Public sector
    is_public_sector: Mapped[bool] = mapped_column(Boolean, default=False)
    is_free: Mapped[bool] = mapped_column(Boolean, default=False)
    require_checkin: Mapped[bool] = mapped_column(Boolean, default=False)
    locality_restricted: Mapped[str | None] = mapped_column(String(100), nullable=True)
    deposit_amount: Mapped[Decimal] = mapped_column(Money, default=0.0)
    no_show_policy: Mapped[str] = mapped_column(String(20), default="refund")
    cancellation_fee_tiers: Mapped[list | None] = mapped_column(
        _JSON_TYPE, nullable=True, doc="Custom cancellation fee tiers [{days_before, fee_pct}]"
    )
    discount_policies: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    resident_priority: Mapped[bool] = mapped_column(Boolean, default=False)
    resident_priority_days: Mapped[int] = mapped_column(Integer, default=7)
    nft_enabled: Mapped[bool] = mapped_column(Boolean, default=False)

    # F4 경품/추첨: raffle_enabled 이벤트의 티켓은 발권 시 이벤트 스코프 유니크
    # raffle_number 를 부여받는다. 기본 false → 기존 이벤트 발권 동작 불변.
    raffle_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )

    # 나이스 카드전용 게이팅(C1) — 이벤트별 허용 결제수단 화이트리스트.
    # NULL(기본)=전체 허용(현행 무변). ["CARD"]=카드전용, ["CARD","VBANK","EASYPAY"] 등.
    # 값은 정규화 대문자(CARD/BANK/VBANK/CELLPHONE/EASYPAY/CARDANDEASYPAY, 나이스 구형
    # 결제창 PayMethod 상수 계약). prepare 단계에서 서버가 요청 pay_method 를 이 목록으로
    # 강제(벗어나면 400)해 payForm 직접 POST 우회를 차단한다.
    allowed_pay_methods: Mapped[list | None] = mapped_column(_JSON_TYPE, nullable=True)
    # 카드사 자동할인 매핑(T13~T15). {"BC": {"rate": 10, "discount_code": "<불투명>"}}
    # NULL = 없음. 금액 차감은 discount_codes 가 하고 v2 가 재계산한다 — 이 컬럼은 매핑만.
    # ⚠️ allowed_pay_methods 와 축이 다르다(결제수단 vs 카드사).
    card_discounts: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)

    # DICE+Laylo DNA absorption (A1, A4)
    brand_color: Mapped[str | None] = mapped_column(String(9), nullable=True)  # #RRGGBB
    brand_color_fg: Mapped[str | None] = mapped_column(String(9), nullable=True)
    service_fee_rate: Mapped[Decimal] = mapped_column(
        Numeric(5, 4), nullable=False, default=Decimal("0.1100")
    )  # All-In Pricing (P1): 11% default

    # ── 레벨2 컷오버 T2-EVT: go events 전용 컬럼 흡수 (마이그 ctevt_0727) ──
    # go DB 제거 후 v2 가 유일 DB 가 되므로, go 에만 있던 주최자측 설정을 여기로 옮긴다.
    # 전부 nullable / server_default 를 가지므로 기존 행 비파괴.
    #
    # 🔴 enabled_features — 주최자 콘솔 기능 토글의 정본(go require-feature.ts 서버 게이트).
    # 빈 배열 = 아무 토글 기능도 켜지지 않음(fail-closed). NULL 을 허용하면 게이트가
    # "미설정"과 "전부 꺼짐"을 구분 못 하므로 NOT NULL DEFAULT '{}'.
    # server_default 는 sale_channels 와 동일하게 **캐스트 없는 배열 리터럴**을 쓴다.
    # `'{}'::text[]` 형태는 sqlite DDL 파서가 ":" 에서 깨져 테스트 create_all 이 실패한다.
    enabled_features: Mapped[list[str]] = mapped_column(
        ARRAY(Text).with_variant(JSON(), "sqlite"),
        server_default="{}",
        default=list,
        nullable=False,
    )
    # 🔴 event_type — go EventType 원본(13종+). v2 category(9종)는 toV2Category() 의
    # **손실 매핑** 결과라 역변환 불가(conference/mice/workshop → 전부 exhibition 으로 뭉개짐).
    # go DB 를 지우기 전 원본을 보존해야 주최자 편집 UI 가 자기 선택값을 되돌려 받는다.
    # category = 소비자 노출·검색용 파생값, event_type = 주최자측 원본. 둘 다 유지한다.
    event_type: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    # 주최자 홈페이지 빌더 디자인(go events.homepage_design).
    homepage_design: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    # 공개 랜딩 구성(go events.landing_config).
    landing_config: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    # 커스텀 도메인(전역 유니크 — 마이그의 부분 유니크 인덱스 uq_events_custom_domain).
    custom_domain: Mapped[str | None] = mapped_column(Text, nullable=True)
    domain_metadata: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    # 대기열 게이트 — go checkout/initiate 가 read 하던 값.
    queue_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    queue_config: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    # RSVP 상세 설정(v2 는 rsvp_enabled 불리언만 갖고 있었다).
    rsvp_config: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    # 초대권(comp) 발급 상한. NULL = 무제한.
    comp_capacity_cap: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    organizer: Mapped["User"] = relationship(lazy="raise")  # noqa: F821
    seat_tiers: Mapped[list["SeatTier"]] = relationship(back_populates="event", lazy="raise")
    bids: Mapped[list["Bid"]] = relationship(back_populates="event", lazy="raise")  # noqa: F821
    allocation: Mapped["Allocation | None"] = relationship(back_populates="event", lazy="raise")  # noqa: F821
    tickets: Mapped[list["Ticket"]] = relationship(back_populates="event", lazy="raise")  # noqa: F821
    orders: Mapped[list["Order"]] = relationship(back_populates="event", lazy="raise")  # noqa: F821

    @property
    def organizer_name(self) -> str | None:
        return self.organizer.name if self.organizer else None

    @property
    def organizer_contact_email(self) -> str | None:
        return self.organizer.email if self.organizer else None

    @property
    def organizer_contact_phone(self) -> str | None:
        return self.organizer.phone if self.organizer else None

    @property
    def blurhash(self) -> str | None:
        return None

    @validates("category")
    def normalize_category(self, key: str, value: str | None) -> str:
        return (value or "concert").lower()


class SeatTier(Base):
    __tablename__ = "seat_tiers"
    __table_args__ = (
        Index("idx_seat_tiers_event_base_price", "event_id", "base_price"),
        Index("idx_seat_tiers_event_sale_mode", "event_id", "sale_mode"),
        CheckConstraint(
            "max_price_cap = 0 OR max_price_cap >= min_price",
            name="ck_seat_tiers_max_price_cap_gte_min",
        ),
        CheckConstraint("base_price >= 0", name="ck_seat_tiers_base_price_nonneg"),
        # W2-PS: `> 0` → `>= 0`. 재고 0(=판매불가/매진)을 표현할 수 있어야 go products.stock=0 을
        # 무제한(1,000,000)으로 승격시키던 초과판매 결함이 닫힌다. capacity=0 티어는 event
        # min/max_price·total_seats 집계(WHERE capacity > 0)와 구매 가능 조회에서 자연 제외된다.
        CheckConstraint("capacity >= 0", name="ck_seat_tiers_capacity_positive"),
        CheckConstraint("sold_count >= 0", name="ck_seat_tiers_sold_count_nonneg"),
        CheckConstraint(
            "sale_mode IN ('fanclub_presale', 'point_lottery', 'queue', 'fixed_fcfs')",
            name="ck_seat_tiers_sale_mode_valid",
        ),
        # SPEC §1.6 — go productId ↔ v2 tier_id 매핑(write-through 멱등 upsert).
        Index("ix_seat_tiers_external_ref", "external_ref", unique=True),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    external_ref: Mapped[str | None] = mapped_column(String(100), nullable=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False)
    base_price: Mapped[Decimal] = mapped_column(Money, nullable=False)

    # Sale mode & pricing
    sale_mode: Mapped[str] = mapped_column(String(50), default="fixed_fcfs")
    face_price: Mapped[Decimal] = mapped_column(Money, default=0.0)
    min_price: Mapped[Decimal] = mapped_column(Money, default=0.0)
    max_price_cap: Mapped[Decimal] = mapped_column(Money, default=0.0)

    # Lottery & group
    lottery_application_hours: Mapped[int] = mapped_column(Integer, default=48)
    fanclub_discount_pct: Mapped[float] = mapped_column(Float, default=0.0)
    allow_group_tickets: Mapped[bool] = mapped_column(Boolean, default=True)
    max_group_size: Mapped[int] = mapped_column(Integer, default=4)

    # Bidding window
    bidding_opens_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    bidding_closes_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # F4 경품번호 대역 시작값(예: 주중권 100001 · 주말권 200001 · 초대권 500001).
    # NULL = 대역 미사용 → 종전 이벤트 스코프 Feistel 코드 경로.
    # 🔴 규칙을 코드가 아니라 데이터로 둔다 — 티어 이름으로 판정하면 이름 한 글자에
    #    깨지고, 코드에 박으면 대회마다 고쳐야 한다.
    raffle_number_base: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sold_count: Mapped[int] = mapped_column(Integer, default=0)

    # Seating
    seating_type: Mapped[str] = mapped_column(String(50), default="assigned")
    section_name: Mapped[str | None] = mapped_column(String(50), nullable=True)

    # View metadata (for seat preview)
    view_description: Mapped[str | None] = mapped_column(String(300), nullable=True)
    distance_from_stage: Mapped[int | None] = mapped_column(Integer, nullable=True)
    view_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    view_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    position_label: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # Resale
    resale_allowed: Mapped[bool] = mapped_column(Boolean, default=True)
    resale_max_price: Mapped[Decimal] = mapped_column(Money, default=0.0)

    # ── T2-ORD: go products 메타 흡수(go DB 제거 선행). 전부 가산·기본값 보유. ──
    # v2 tier 는 name/capacity/base_price/sale_mode/sale_window 만 가지고 있었다.
    # 아래가 없으면 go products 제거 시 상품 설명·세금·이미지·정렬·수량제한·번들이 소실된다.
    # sale_window 는 기존 bidding_opens_at/bidding_closes_at 재사용(신규 컬럼 없음).
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # ticket | addon | bundle | donation (go products.type 동등)
    product_type: Mapped[str] = mapped_column(String(20), nullable=False, default="ticket")
    # public | private | hidden (go products.visibility 동등)
    visibility: Mapped[str] = mapped_column(String(20), nullable=False, default="public")
    tax_rate: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    tax_included: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    min_per_order: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    max_per_order: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # ── W2-PS: go products.stock + seat_tiers 빌더 메타 흡수(alembic w2ps_0727). ──
    # stock_limit = 주최자가 입력한 재고 **원본**(NULL=무제한, 0=재고없음).
    #   capacity 는 여기서 파생한 집행값이라 둘이 분리돼야 왕복 손실이 없다
    #   (무제한 sentinel 1,000,000 과 "정확히 100만 재고"를 구분할 수 없던 문제).
    stock_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    color_hex: Mapped[str | None] = mapped_column(String(9), nullable=True)
    # 좌석 빌더에서 이 티어가 속한 배치도(go seat_tiers.seat_map_id). v2 seat_maps 테이블은 없고
    # 배치도는 events.seat_map_data(JSONB)라 FK 를 걸지 않는다(느슨한 참조).
    seat_map_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # `_JSON_TYPE`(JSONB + sqlite JSON 변형) — 테스트가 sqlite 를 쓰므로 순수 JSONB 는 렌더 불가.
    tier_metadata: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    # 번들 구성(go product_bundle_items 대체): [{"external_ref": "<go productId>", "quantity": 1}]
    bundle_items: Mapped[list | None] = mapped_column(_JSON_TYPE, nullable=True)

    event: Mapped["Event"] = relationship(back_populates="seat_tiers", lazy="raise")
    seats: Mapped[list["Seat"]] = relationship(back_populates="tier", lazy="raise")  # noqa: F821
    tickets: Mapped[list["Ticket"]] = relationship(back_populates="tier", lazy="raise")  # noqa: F821
