"""B2B 주최자 대기열(Waitlist) — go `waitlist_entries` 워크플로의 v2 정본.

레벨2 컷오버(스코프A): go DB 완전제거 목표에 따라 organizer 대기열을 v2 로 이관한다.
주의: 이 모델은 **소비자 액면가 대기열**(`app.models.waitlist.WaitlistEntryModel`,
feature-flag off, tier/lottery 기반)과 **완전히 별개**다. 혼동 금지.

go 워크플로(마이그 033/216):
  waiting → offered(구매 제안·딥링크 발송) → converted(주문 전환) | cancelled | expired
  - offer_token_version: 재발송 시 증가 → 이전 딥링크 토큰 무효화(HMAC 서명 payload 에 포함).
  - converted_order_id: offered→converted 전환 시 생성된 주문 앵커(멱등 재생 대상).

멀티테넌트 경계: 모든 조회/집계는 account_id 경계를 강제한다(크로스테넌트 누출=Critical).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OrganizerWaitlistStatus(str, PyEnum):
    """go CHECK 제약과 동일 어휘(waiting/offered/converted/cancelled/expired)."""

    WAITING = "waiting"
    OFFERED = "offered"
    CONVERTED = "converted"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


# 상태별 허용 전이 — go route ALLOWED_TRANSITIONS 를 v2 정본으로 이관.
#   waiting  → offered | cancelled
#   offered  → waiting | cancelled | expired | converted
#   expired  → offered            (재제안 허용)
#   converted / cancelled → (종단)
ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    "waiting": frozenset({"offered", "cancelled"}),
    "offered": frozenset({"waiting", "cancelled", "expired", "converted"}),
    "expired": frozenset({"offered"}),
    "converted": frozenset(),
    "cancelled": frozenset(),
}


class OrganizerWaitlistEntry(Base):
    """주최자 대기열 항목. go waitlist_entries 1:1 이관(자립적 스냅샷 보관)."""

    __tablename__ = "organizer_waitlist_entries"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # 멀티테넌트 경계 — go account_id(=주최자 계정). 모든 조회에 필수.
    account_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # go event id == v2 canonical Event.id (external_ref 단일화 계약).
    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # go product id(대기 대상 상품). v2 tier 와 별개 — go 원본 UUID 를 스냅샷 보관.
    product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    # 신청자 스냅샷(go 원본 — 비회원 신청 지원).
    name: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[str] = mapped_column(Text, nullable=False)
    phone: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="waiting"
    )

    # 제안 라이프사이클.
    offered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 재발송 시 증가 → 이전 딥링크 토큰 무효화. BIGINT(원 단위 아님, 버전 카운터).
    offer_token_version: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    # offered→converted 전환 주문 앵커(go orders.id). 멱등 재생 대상.
    converted_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        # go UNIQUE (event_id, product_id, email) — 동일 상품 중복 신청 차단.
        UniqueConstraint("event_id", "product_id", "email", name="uq_org_waitlist_event_product_email"),
        CheckConstraint(
            "status IN ('waiting','offered','converted','cancelled','expired')",
            name="ck_org_waitlist_status",
        ),
        # 목록 조회(account 경계 + 이벤트 + 상태 필터) 인덱스.
        Index("ix_org_waitlist_account_event", "account_id", "event_id", "status"),
        # reaper(offered && expires_at < now) 스캔 인덱스.
        Index("ix_org_waitlist_offer_expiry", "status", "expires_at"),
    )
