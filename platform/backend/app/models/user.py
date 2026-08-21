import uuid
from datetime import date, datetime, timezone

from sqlalchemy import String, Boolean, DateTime, Float, Integer, JSON, Index
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.core.pii import EncryptedDate, EncryptedString

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        Index("idx_user_ci_hash", "ci_hash"),
        Index("idx_user_di_hash", "di_hash"),
        Index("idx_user_oauth", "oauth_provider", "oauth_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    phone: Mapped[str | None] = mapped_column(EncryptedString(length=512), nullable=True)
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    is_organizer: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Layer 1: Eligibility (0=unverified, 1=phone, 2=real_name, 3=foreign_alt)
    verification_level: Mapped[int] = mapped_column(Integer, default=0)

    # Layer 2: Fan weight v2 dimensions
    # s₁ loyalty — artist-based (external data; default 0.5 = neutral)
    loyalty_score: Mapped[float] = mapped_column(Float, default=0.5)
    # s₂ history — computed from attendance records (with 2-year half-life decay)
    history_score: Mapped[float] = mapped_column(Float, default=0.0)
    # s₃ fanclub — active paid membership (0 or 1)
    is_fanclub_member: Mapped[bool] = mapped_column(Boolean, default=False)
    # s₄ behavior — trust score
    no_show_rate: Mapped[float] = mapped_column(Float, default=0.0)
    cancel_rate: Mapped[float] = mapped_column(Float, default=0.0)
    dispute_rate: Mapped[float] = mapped_column(Float, default=0.0)

    # Legacy field (kept for v1 compatibility, not used in v2)
    _legacy_loyalty: Mapped[float] = mapped_column("legacy_loyalty", Float, default=0.0)

    # Identity & extended profile
    ci_hash: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)
    di_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    date_of_birth: Mapped[date | None] = mapped_column(EncryptedDate(length=512), nullable=True)
    nationality: Mapped[str | None] = mapped_column(String(2), nullable=True)  # ISO 3166-1 alpha-2
    preferred_language: Mapped[str | None] = mapped_column(String(5), nullable=True, default="ko")
    timezone: Mapped[str | None] = mapped_column(String(50), nullable=True, default="Asia/Seoul")
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    admin_role: Mapped[str] = mapped_column(String(30), nullable=False, default="viewer", server_default="viewer")
    abuse_score: Mapped[float] = mapped_column(Float, default=0.0)
    payment_account_id: Mapped[str | None] = mapped_column(EncryptedString(length=512), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    bio: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # WP16: Newcomer Shield — 3 uses for new users within 30 days of signup
    newcomer_uses_remaining: Mapped[int] = mapped_column(Integer, default=3)

    # MFA (TOTP for admin accounts)
    mfa_secret: Mapped[str | None] = mapped_column(String(512), nullable=True)  # encrypted TOTP secret
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    mfa_backup_codes: Mapped[str | None] = mapped_column(String(2048), nullable=True)  # 암호화된 백업 코드 JSON

    # OAuth2 social login
    oauth_provider: Mapped[str | None] = mapped_column(
        String(20), nullable=True
    )  # kakao/google/naver
    oauth_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    notification_preferences: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True, default=None)

    # Residence verification
    residential_city: Mapped[str | None] = mapped_column(String(50), nullable=True)
    residential_district: Mapped[str | None] = mapped_column(String(50), nullable=True)
    residence_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    residence_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # GDPR/PIPA: 계정 삭제 관련
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deletion_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Organizer 전용 필드 (go BFF 통합 — 주최자 비즈니스 정보)
    business_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    business_registration_number: Mapped[str | None] = mapped_column(
        EncryptedString(length=512), nullable=True
    )
    business_representative: Mapped[str | None] = mapped_column(String(100), nullable=True)
    business_phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    settlement_bank: Mapped[str | None] = mapped_column(String(50), nullable=True)
    settlement_account_holder: Mapped[str | None] = mapped_column(String(100), nullable=True)
    settlement_account_number: Mapped[str | None] = mapped_column(
        EncryptedString(length=512), nullable=True
    )
    # go 측 organizer record 와 매핑 (transition 기간 — 데이터 추적용)
    go_organizer_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)

    # WP13: 멤버십 티어
    membership_tier: Mapped[str] = mapped_column(
        String(20), default="rookie"
    )  # rookie/fan/supporter/corefan/legend
    tier_score: Mapped[float] = mapped_column(Float, default=0.0)
    tier_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    tier_downgrade_warned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    bids: Mapped[list["Bid"]] = relationship(back_populates="user", lazy="raise")  # noqa: F821
    billing_keys: Mapped[list["BillingKey"]] = relationship(back_populates="user", lazy="raise")  # noqa: F821
    delegation_tokens: Mapped[list["DelegationToken"]] = relationship(back_populates="user", lazy="raise")  # noqa: F821
