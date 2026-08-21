"""레벨2 W5-CONTENT — go 콘텐츠·표시 계열 테이블의 v2 정본 흡수.

go DB 완전 제거 컷오버. go 에만 있던 6개 테이블을 v2 로 옮긴다(폐기 아님 — 전부 살린다).

  go widget_configs      → v2 organizer_widget_configs      (embed 위젯 설정)
  go ticket_designs      → v2 organizer_ticket_designs      (티켓 디자이너 canvas)
  go bridge_pages        → v2 organizer_bridge_pages        (판매 전 브릿지 페이지)
  go open_notices        → v2 organizer_open_notices        (공개 공지, 발행 워크플로 포함)
  go event_facilities    → v2 organizer_event_facilities    (시설, vendor/cost/notes 포함)
  go event_participants  → v2 organizer_event_participants  (출연진, is_visible 포함)

## 왜 기존 `event_mirror` 테이블(event_participants/event_announcements/event_facilities)을
## 그대로 쓰지 않는가 — **일부러 분리한다**

`event_mirror` 의 3개 테이블은 **소비자 노출 투영(projection)** 이다:
  · 소비자 상세(`GET /events/{id}`)가 필터 없이 통째로 내보낸다.
  · go 가 `is_visible=true` / `is_published=true` 인 행만 골라 push 해 왔기 때문에
    "그 테이블에 있는 것 = 공개해도 되는 것" 이라는 불변식이 성립한다.

여기에 주최자 워크플로 필드(is_visible=false 인 숨김 출연진, is_published=false 인 미발행
공지, vendor/cost/notes 같은 내부 원가)를 섞으면 그 불변식이 깨진다. 소비자 read 한 곳만
필터를 빠뜨려도 **미발행 공지·숨김 출연진·거래처 단가가 공개**된다(P0급 노출 사고).
게다가 기존 `PUT /internal/events/{id}/content` 는 delete-then-insert 라, 남아 있는 어떤
호출자든 한 번만 때리면 주최자 편집 원본이 통째로 날아간다.

그래서 **정본(이 파일)과 투영(event_mirror)을 분리**한다.
  · 정본 = 주최자가 편집하는 전체 데이터(숨김/미발행/내부필드 포함).
  · 투영 = 공개 가능한 부분집합. 정본이 바뀔 때마다 **같은 트랜잭션에서** 재작성한다
    (`internal_organizer_content._reproject_*`). 같은 DB 안이라 원자적이고, 외부호출도
    아웃박스도 필요 없다.
투영이 어긋나면 다음 편집이 고치지만, 숨김 데이터가 새는 것은 되돌릴 수 없다 —
비대칭한 위험을 스키마 구조로 막는 선택이다.

## 테넌트 경계
이 테이블들에는 organizer 컬럼이 없다. 경계는 **event_id → events.organizer_id** 로만
강제한다(`internal_organizer_content._owned_event`). 컬럼을 중복 보관하면 이벤트 소유자가
바뀔 때 두 값이 어긋나 경계가 무너진다 — 경계는 한 군데에만 둔다.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# postgres 는 JSONB, 테스트(sqlite)는 JSON. go 의 `text[]`(allowed_domains)도 JSON 배열로
# 통일한다 — 배열 타입은 sqlite 에 없고, 도메인 목록은 순서/중복 의미가 없어 손실이 없다.
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")

# go DB CHECK 제약과 동일한 허용값. 여기서는 상수로만 두고 API 계층이 400 으로 검증한다
# (DB CHECK 로 두면 위반이 500 으로 터져 "무엇이 잘못됐는지" 를 주최자에게 못 알려준다).
PARTICIPANT_ROLES = ("performer", "speaker", "mc", "dj", "guest")
NOTICE_TYPES = ("cancellation", "refund", "schedule_change", "general")
FACILITY_CATEGORIES = ("stage", "sound", "lighting", "booth", "seating", "general")
FACILITY_STATUSES = ("planned", "confirmed", "setup", "active", "returned")
WIDGET_MODES = ("button", "inline", "mini")


def _now() -> datetime:
    return datetime.now(timezone.utc)


class OrganizerEventParticipant(Base):
    """출연진 정본 (go event_participants). 숨김(is_visible=false) 행도 여기 남는다."""

    __tablename__ = "organizer_event_participants"
    __table_args__ = (
        Index("idx_org_event_participants_event_sort", "event_id", "sort_order"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[str] = mapped_column(String(50), nullable=False, default="performer")
    bio: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    social_links: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class OrganizerOpenNotice(Base):
    """공개 공지 정본 (go open_notices). 미발행(is_published=false) 초안도 여기 남는다."""

    __tablename__ = "organizer_open_notices"
    __table_args__ = (
        Index("idx_org_open_notices_event_published", "event_id", "is_published"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    notice_type: Mapped[str] = mapped_column(String(50), nullable=False, default="general")
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    is_published: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class OrganizerEventFacility(Base):
    """시설 정본 (go event_facilities). vendor/cost/notes 는 **내부 전용**(소비자 미노출)."""

    __tablename__ = "organizer_event_facilities"
    __table_args__ = (Index("idx_org_event_facilities_event", "event_id"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[str] = mapped_column(String(50), nullable=False, default="general")
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="planned")
    vendor: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # 금액은 원 단위 정수(BIGINT) — go BIGINT 와 동일 축.
    cost: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class OrganizerWidgetConfig(Base):
    """embed 위젯 설정 (go widget_configs). 이벤트 1:1.

    🔴 `allowed_domains` 는 외부 사이트 embed **허용 화이트리스트**다. 조회에 실패했을 때
    "빈 목록(=제한 없음)" 으로 흘리면 아무 사이트나 위젯을 박을 수 있게 된다.
    행이 실제로 없는 것(미설정 = 제한 없음, go 기존 동작)과 조회 실패는 응답에서 반드시
    구분한다 — `configured` 플래그를 함께 내보내는 이유.
    """

    __tablename__ = "organizer_widget_configs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("events.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    mode: Mapped[str] = mapped_column(String(20), nullable=False, default="button")
    theme: Mapped[dict] = mapped_column(_JSON_TYPE, nullable=False, default=dict)
    allowed_domains: Mapped[list] = mapped_column(_JSON_TYPE, nullable=False, default=list)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class OrganizerTicketDesign(Base):
    """티켓 디자이너 canvas (go ticket_designs). 이벤트 1:1.

    `canvas_json` 은 티켓 디자이너와 초대권 편집기가 **공유**한다 → PUT 은 전체교체가 아니라
    **top-level 병합**이다(go 의 jsonb `||` 와 동일). 한쪽 저장이 다른 쪽 필드를 지우면 안 된다.
    """

    __tablename__ = "organizer_ticket_designs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("events.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="기본 티켓 디자인")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    canvas_json: Mapped[dict] = mapped_column(_JSON_TYPE, nullable=False, default=dict)
    preview_image_url: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class OrganizerBridgePage(Base):
    """판매 전 브릿지 페이지 (go bridge_pages). 이벤트 1:1.

    ⚠️ v2 에 이미 있는 `bridge_pages`(복수 이벤트 홍보 랜딩, slug 기반)와는 **다른 개념**이다.
    이름이 같아 재사용하고 싶어지지만 스키마·소유축·용도가 전부 달라 섞으면 안 된다.
    """

    __tablename__ = "organizer_bridge_pages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("events.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    countdown_target: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    background_color: Mapped[str] = mapped_column(String(20), nullable=False, default="#6C5CE7")
    logo_url: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    custom_css: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
