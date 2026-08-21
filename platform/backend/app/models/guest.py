"""게스트(비회원) 도메인 — 상세페이지 통합 S1.

설계 정본: docs/plans/DETAIL-UNIFICATION-DB-DESIGN.md §2.1(C안)·§2.3·§2.4·§7.4.

배경: 기존 `_resolve_buyer_user`("게스트=진짜 User 생성")는 안티패턴 —
users.email UNIQUE 오염·유령계정·PIPA 위반. → **별도 guests 엔티티(C안)**로 재설계.

- `Guest`: 비회원 구매자 스냅샷. email 은 **UNIQUE 아님**(스냅샷·동일 email 여러 주문 허용).
  회원 승격(claim) 시 claimed_user_id 로 User 에 rebind(FK SET NULL, User merge 불필요).
- `GuestAccessToken`: IDOR 방어용 단회용(single-use) 조회/환불/클레임 토큰.
  token_hash(SHA-256 hex)만 저장 — 원문 미저장.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.pii import EncryptedString


class Guest(Base):
    """비회원 구매자 엔티티(C안). users.email UNIQUE 오염 없이 게스트 주문 수용."""

    __tablename__ = "guests"
    __table_args__ = (
        # email 조회용(매직링크 enumeration — 해시 아님, 일반 btree). 매칭여부는 API 계층에서 미노출.
        Index("idx_guests_email", "email"),
        # 미클레임 게스트 부분 인덱스(claim 매칭 핫패스).
        Index(
            "idx_guests_unclaimed",
            "email",
            postgresql_where=text("claimed_user_id IS NULL AND deleted_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # 스냅샷 — UNIQUE 아님(§2.1). 동일 email 여러 주문/게스트 허용, 매직링크로 disambiguate.
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # 암호화 저장(EncryptedString TypeDecorator — 기존 v2 PII 유틸 재사용). PII_ENCRYPTION_KEY 미설정 시 평문 폴백.
    phone_enc: Mapped[str | None] = mapped_column(EncryptedString(length=512), nullable=True)
    marketing_opt_in: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # 회원 승격(claim) — FK SET NULL(회원 삭제 시 게스트 주문 이력 보존). §2.4 rebind.
    claimed_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # v2 soft-delete 패턴(§7.4).
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 설계정합: 마이그와 동일 — server_default=now() + NOT NULL(raw insert NULL 방지, v2 컨벤션).
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


# 토큰 용도 화이트리스트(§2.3): 조회/환불/클레임.
GUEST_TOKEN_PURPOSES = ("view", "refund", "claim")


class GuestAccessToken(Base):
    """게스트 IDOR 방어용 단회용 토큰. SHA-256 hex 만 저장(원문 미저장·§2.3)."""

    __tablename__ = "guest_access_tokens"
    __table_args__ = (
        CheckConstraint(
            "purpose IN ('view', 'refund', 'claim')",
            name="ck_guest_access_tokens_purpose_valid",
        ),
        # 미소진 토큰 조회 핫패스(purpose+guest 스코프).
        Index(
            "idx_guest_access_tokens_guest_purpose",
            "guest_id",
            "purpose",
            postgresql_where=text("used_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    guest_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("guests.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # SHA-256 hex(64자) — 원문 미저장. UNIQUE(조회 시 hash 매칭).
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    purpose: Mapped[str] = mapped_column(String(20), nullable=False)
    # 주문 스코프 토큰(view/refund) — FK CASCADE(주문 삭제 시 토큰 소멸). claim 은 주문 무관하므로 nullable.
    order_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), nullable=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # single-use — 소비 시점 기록(NULL=미사용).
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    # 설계정합: 마이그와 동일 — server_default=now() + NOT NULL(raw insert NULL 방지, v2 컨벤션).
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(timezone.utc),
    )
