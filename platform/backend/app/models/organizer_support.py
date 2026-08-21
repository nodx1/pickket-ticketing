"""레벨2 W5-SUPPORT — 문의·게시심사·용량·파이널콜 원장 (go 흡수).

go(pickket.go) DB 완전 제거 컷오버. go 에만 있던 아래 4개 테이블을 v2 정본으로 흡수한다.

정본 매핑(go 마이그레이션 → v2 테이블):
  - 152 `event_reviews`         → `event_publication_reviews`  ⚠️ 이름 주의(아래)
  - 189/219 `event_inquiries`   → `event_inquiries`
  - 033 `capacity_assignments`  → `capacity_assignments`
  - 107 `final_call_rules`      → `final_call_rules`           ⚠️ 이름 주의(아래)

🔴 동명 다개념 2건 — 절대 재사용 금지
  1. go `event_reviews` 는 **게시 심사 원장**(주최자 submit → 어드민 approve/reject →
     resubmit)이다. v2 `reviews`(app/models/review.py)는 **관람객이 공연에 남기는 후기**로
     완전히 다른 개념이다. 한 테이블로 합치면 "후기 1건 = 승인 1건"이 되어 **미심사 이벤트가
     공개**되거나 정당한 이벤트가 막힌다. 그래서 `event_publication_reviews` 라는
     의도적으로 다른 이름으로 신설한다("publication" = 게시 승인이라는 뜻을 이름에 박는다).
  2. go `final_call_rules` 는 **규칙 설정**(발동 시점·할인율·최소 잔여율·통지여부)이고,
     v2 `final_calls`(app/models/final_call.py)는 **실행 인스턴스**(확정 할인가·오픈일시·
     status)다. 규칙 1건이 인스턴스 N건을 낳는 관계라 1:1 이 아니다 → 별도 테이블.

스코프 규칙(크로스테넌트 경계 — Critical):
  - 4개 테이블 모두 `events.id` FK 로 이벤트에 매달린다(W2-EVT `event_host_links` 와 동일 규약).
    go event id == v2 event id 항등이므로 id 재매핑이 없다.
  - 🔴 go 의 `account_id` 컬럼은 **복제하지 않는다**. 테넌트 경계는 `events.organizer_id`
    단일 축이 강제한다(중복 컬럼은 두 축이 갈라질 때 조용한 누출이 된다 — W2-EVT 판단 계승).
    특히 go `event_reviews` 에는 애초에 account_id 가 없었고 `JOIN events` 가 유일한 경계였다.
  - 따라서 **모든 조회·변경은 events 를 경유해 organizer_id 를 확인한 뒤** 수행한다
    (app/api/v1/internal_support.py `_owned_event`).

SQLite(테스트) 호환: JSONB → JSON variant 폴백.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# JSONB(prod) / JSON(sqlite test) — 동일 dict API.
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")
# conftest 의 @compiles(PG_UUID,"sqlite")→CHAR(32) 로 테스트 호환(코드베이스 전역 컨벤션).
_UUID_TYPE = UUID(as_uuid=True)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ─────────────────────────────────────────────────────────────────────────────
# 1) 게시 심사 원장 (go 152 event_reviews)
# ─────────────────────────────────────────────────────────────────────────────
PUBLICATION_REVIEW_ACTIONS = ("submit", "approve", "reject", "resubmit", "auto_approved")


class EventPublicationReview(Base):
    """이벤트 **게시 심사** 이력. 주최자 submit → 어드민 approve/reject → 주최자 resubmit.

    🔴 v2 `reviews`(관람객 후기)와 무관한 별개 원장이다. 이 원장의 조회가 실패하면
       "승인됨"으로도 "반려됨"으로도 흘리면 안 된다 — 호출측은 503 으로 모름을 알린다.
    """

    __tablename__ = "event_publication_reviews"
    __table_args__ = (
        CheckConstraint(
            "action IN ('submit','approve','reject','resubmit','auto_approved')",
            name="ck_event_publication_reviews_action",
        ),
        # go idx_event_reviews_event_created 재현(이벤트별 최신순 조회).
        Index("idx_event_publication_reviews_event_created", "event_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        _UUID_TYPE, ForeignKey("events.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 심사 주체 식별자. go 는 users.id FK 였으나 심사자는 go 주최자 계정일 수도(submit),
    # v2 플랫폼 어드민일 수도(approve/reject) 있어 **문자열 ref** 로 보관한다(FK 없음 —
    # 어느 한쪽 테이블로 강제하면 나머지 경로의 이력이 유실된다).
    reviewer_ref: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # 표시용 심사자 이름 스냅샷. go 는 `LEFT JOIN users u` 로 매번 조회했지만, 심사자가
    # v2 어드민/go 유저 양쪽이라 조인 대상이 하나가 아니다 → 기록 시점 스냅샷으로 고정.
    reviewer_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    action: Mapped[str] = mapped_column(String(20), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    checklist: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )


# ─────────────────────────────────────────────────────────────────────────────
# 2) 소비자 문의 (go 189 event_inquiries + 219 분류 컬럼)
# ─────────────────────────────────────────────────────────────────────────────
EVENT_INQUIRY_STATUSES = ("open", "answered", "archived")
EVENT_INQUIRY_SOURCES = ("web", "chatbot", "import")
EVENT_INQUIRY_CATEGORIES = ("refund", "schedule", "product", "access", "payment", "other")
EVENT_INQUIRY_URGENCIES = ("low", "normal", "high")


class EventInquiry(Base):
    """소비자 문의(FAQ 데이터소스 + 주최자 인박스).

    접수는 **비인증 공개 경로**(go `api/public/inquiries`)에서 들어온다. 저장 실패를 성공으로
    흘리면 고객은 접수됐다고 믿는데 아무 데도 남지 않으므로, 이 테이블 write 실패는 반드시
    호출측까지 전파된다.

    `contact` 는 PII(회신용 이메일/전화) — 목록 응답에서 마스킹은 go 표시 계층이 수행한다.
    """

    __tablename__ = "event_inquiries"
    __table_args__ = (
        CheckConstraint(
            "status IN ('open','answered','archived')", name="ck_event_inquiries_status"
        ),
        CheckConstraint(
            "category IS NULL OR category IN "
            "('refund','schedule','product','access','payment','other')",
            name="ck_event_inquiries_category",
        ),
        CheckConstraint(
            "urgency IS NULL OR urgency IN ('low','normal','high')",
            name="ck_event_inquiries_urgency",
        ),
        # go idx_event_inquiries_event 재현(이벤트+상태별 최신순).
        Index("idx_event_inquiries_event_status_created", "event_id", "status", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        _UUID_TYPE, ForeignKey("events.id", ondelete="CASCADE"), nullable=False, index=True
    )
    contact: Mapped[str | None] = mapped_column(Text, nullable=True)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=text("'open'"), default="open"
    )
    source: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=text("'web'"), default="web"
    )
    # go 219 — CS 트리아지 분류(현재는 go 쪽에서 채우지 않지만 컬럼 유실 방지로 흡수).
    category: Mapped[str | None] = mapped_column(String(20), nullable=True)
    urgency: Mapped[str | None] = mapped_column(String(10), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )


# ─────────────────────────────────────────────────────────────────────────────
# 3) 용량 배정 (go 033 capacity_assignments)
# ─────────────────────────────────────────────────────────────────────────────
CAPACITY_ASSIGNMENT_STATUSES = ("active", "paused")


class CapacityAssignment(Base):
    """상품(=v2 seat_tier)별 용량 배정.

    `product_id` 는 go products.id 였고, W2-PS 이후 v2 `seat_tiers.external_ref` 와 같은 축이다.
    v2 tier UUID 로 강제 변환하지 않는다 — go 폼이 external_ref 를 그대로 넘기고, 미동기화
    상품에도 배정을 남길 수 있어야 하기 때문(FK 대신 문자열 ref).
    """

    __tablename__ = "capacity_assignments"
    __table_args__ = (
        UniqueConstraint("event_id", "product_ref", name="uq_capacity_assignments_event_product"),
        CheckConstraint(
            "status IN ('active','paused')", name="ck_capacity_assignments_status"
        ),
        Index("idx_capacity_assignments_event", "event_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        _UUID_TYPE, ForeignKey("events.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # go products.id == v2 seat_tiers.external_ref (W2-PS). FK 없음(위 docstring).
    product_ref: Mapped[str] = mapped_column(String(100), nullable=False)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False)
    used_capacity: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0"), default=0
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=text("'active'"), default="active"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )


# ─────────────────────────────────────────────────────────────────────────────
# 4) 파이널콜 규칙 (go 107 final_call_rules)
# ─────────────────────────────────────────────────────────────────────────────
class FinalCallRule(Base):
    """막판 할인 **규칙**(이벤트당 최대 1건).

    ⚠️ v2 `final_calls`(FinalCall) 는 확정된 **실행 인스턴스**다. 이 테이블은 그 인스턴스를
       언제·얼마로 만들지 정하는 설정이므로 별개다(위 모듈 docstring 참조).
    """

    __tablename__ = "final_call_rules"
    __table_args__ = (
        # go idx_final_call_event(UNIQUE) 재현 — 이벤트당 1행.
        UniqueConstraint("event_id", name="uq_final_call_rules_event"),
        CheckConstraint(
            "discount_percent >= 5 AND discount_percent <= 80",
            name="ck_final_call_rules_discount_percent",
        ),
        CheckConstraint(
            "min_remaining_percent >= 0 AND min_remaining_percent <= 90",
            name="ck_final_call_rules_min_remaining_percent",
        ),
        CheckConstraint(
            "trigger_hours_before >= 1 AND trigger_hours_before <= 720",
            name="ck_final_call_rules_trigger_hours",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(_UUID_TYPE, primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        _UUID_TYPE, ForeignKey("events.id", ondelete="CASCADE"), nullable=False, index=True
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
    trigger_hours_before: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("24"), default=24
    )
    discount_percent: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("30"), default=30
    )
    min_remaining_percent: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("20"), default=20
    )
    max_discount_tickets: Mapped[int | None] = mapped_column(Integer, nullable=True)
    notify_buyers: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), default=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now
    )


__all__ = [
    "EventPublicationReview",
    "EventInquiry",
    "CapacityAssignment",
    "FinalCallRule",
    "PUBLICATION_REVIEW_ACTIONS",
    "EVENT_INQUIRY_STATUSES",
    "EVENT_INQUIRY_SOURCES",
    "EVENT_INQUIRY_CATEGORIES",
    "EVENT_INQUIRY_URGENCIES",
    "CAPACITY_ASSIGNMENT_STATUSES",
]
