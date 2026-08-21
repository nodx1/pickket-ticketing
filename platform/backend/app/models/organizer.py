"""주최자(Organizer) 프로필 모델.

주최자 포탈 가입 시 생성되는 주최자 프로필.
사업자 정보, 승인 상태, 주요 활동 도메인 등을 관리한다.
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import String, DateTime, ForeignKey, Enum, Text, Index, Integer, JSON
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.pii import EncryptedString

# 테스트는 SQLite 로 돈다 — JSONB 는 SQLite 컴파일러가 모르므로 JSON 으로 variant 한다
# (audit_log·business_verification 등 기존 모델과 동일 패턴).
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class OrganizerStatus(str, PyEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    SUSPENDED = "suspended"


class TrustTier(str, PyEnum):
    NEW = "new"
    VERIFIED = "verified"
    PREMIUM = "premium"


class OrganizerProfile(Base):
    __tablename__ = "organizer_profiles"
    __table_args__ = (
        Index("idx_organizer_profiles_user_id", "user_id"),
        Index("idx_organizer_profiles_status", "status"),
        Index("idx_organizer_profiles_go_account_id", "go_account_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, unique=True
    )
    company_name: Mapped[str] = mapped_column(String(200), nullable=False)
    business_number: Mapped[str | None] = mapped_column(EncryptedString(length=512), nullable=True)
    representative_name: Mapped[str | None] = mapped_column(EncryptedString(length=512), nullable=True)
    address: Mapped[str | None] = mapped_column(EncryptedString(length=1024), nullable=True)
    contact_phone: Mapped[str | None] = mapped_column(EncryptedString(length=512), nullable=True)
    contact_email: Mapped[str] = mapped_column(EncryptedString(length=512), nullable=False)
    # JSON array string of domains, e.g. ["concert","sports"]
    primary_domains: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[OrganizerStatus] = mapped_column(
        Enum(OrganizerStatus, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20),
        default=OrganizerStatus.PENDING,
        nullable=False,
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    # ── BFF cutover 필드 (go account 매핑 + 신뢰 시스템) ──
    slug: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)
    trust_tier: Mapped[TrustTier] = mapped_column(
        Enum(TrustTier, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20),
        default=TrustTier.NEW,
        server_default=TrustTier.NEW.value,
        nullable=False,
    )
    trust_score: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    go_account_id: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)

    # ── 레벨2 컷오버 T1: go `accounts` 운영 설정 흡수 (mig mainfix_0727, 전부 가산) ──
    # 주최자 알림 수신 설정(6키 JSONB) · 조직 로케일. go accounts 가 비워지며 계정 화면이
    # 404 로 파손된 것을 v2 정본으로 대체하기 위해 옮겼다.
    notification_prefs: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    timezone: Mapped[str] = mapped_column(
        String(64), default="Asia/Seoul", server_default="Asia/Seoul", nullable=False
    )
    currency: Mapped[str] = mapped_column(
        String(8), default="KRW", server_default="KRW", nullable=False
    )

    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
