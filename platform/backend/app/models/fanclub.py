import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import (
    String,
    Integer,
    Boolean,
    DateTime,
    Text,
    ForeignKey,
    UniqueConstraint,
    Index,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates

from app.core.database import Base

# Valid event type template values (mirroring engine EventType enum)
_VALID_EVENT_TYPE_TEMPLATES = {
    "general_concert",
    "fanclub_exclusive",
    "festival",
    "high_demand_tour",
    "new_artist",
    "sports_match",
    "sports_playoff",
    "exhibition",
    "classical",
    "esports",
    "education",
    "civic_participation",
}


class CommunityType(str, PyEnum):
    FANCLUB = "fanclub"
    SUPPORTER = "supporter"
    GUILD = "guild"
    ASSOCIATION = "association"
    SOCIETY = "society"
    GENERAL = "general"


class MembershipTier(str, PyEnum):
    BASIC = "basic"
    PREMIUM = "premium"
    VIP = "vip"


class MembershipStatus(str, PyEnum):
    PENDING = "pending"
    ACTIVE = "active"
    EXPIRED = "expired"
    REVOKED = "revoked"


class Fanclub(Base):
    __tablename__ = "fanclubs"
    __table_args__ = (
        Index("idx_fanclubs_artist_name", "artist_name"),
        Index("idx_fanclubs_organizer_id", "organizer_id"),
        Index("idx_fanclubs_community_type", "community_type"),
        Index("idx_fanclubs_domain", "domain"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    artist_name: Mapped[str] = mapped_column(String(200), nullable=False)
    artist_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    logo_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    max_members: Mapped[int] = mapped_column(Integer, default=500000)
    is_official: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Multi-domain community fields
    community_type: Mapped[str] = mapped_column(
        String(30),
        default=CommunityType.FANCLUB.value,
        nullable=False,
        server_default="fanclub",
    )
    subject_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    domain: Mapped[str | None] = mapped_column(String(50), nullable=True)
    custom_tier_labels: Mapped[str | None] = mapped_column(Text, nullable=True)
    custom_member_label: Mapped[str | None] = mapped_column(String(50), nullable=True)
    event_type_template: Mapped[str | None] = mapped_column(String(50), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    memberships: Mapped[list["FanclubMembership"]] = relationship(
        back_populates="fanclub", cascade="all, delete-orphan", lazy="raise"
    )

    @validates("event_type_template")
    def validate_event_type_template(self, key: str, value: str | None) -> str | None:
        """Ensure event_type_template is a valid EventType enum value."""
        if value is None:
            return value
        if value not in _VALID_EVENT_TYPE_TEMPLATES:
            raise ValueError(
                f"Invalid event_type_template '{value}'. "
                f"Must be one of: {sorted(_VALID_EVENT_TYPE_TEMPLATES)}"
            )
        return value


class FanclubMembership(Base):
    __tablename__ = "fanclub_memberships"
    __table_args__ = (
        UniqueConstraint("user_id", "fanclub_id", name="uq_user_fanclub"),
        Index("idx_membership_fanclub_status", "fanclub_id", "status"),
        Index("idx_membership_user_active", "user_id", "status"),
        Index("idx_membership_fanclub_tier", "fanclub_id", "tier"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    fanclub_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("fanclubs.id", ondelete="CASCADE"), nullable=False
    )
    tier: Mapped[str] = mapped_column(String(20), default=MembershipTier.BASIC.value)
    status: Mapped[str] = mapped_column(String(20), default=MembershipStatus.PENDING.value)
    membership_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    # WP06: Conflict of interest flag — True when user is affiliated
    # with the organizer (e.g. team member). These members are excluded
    # from Pool D (fanclub guaranteed) and premium seat allocation.
    is_organizer_affiliated: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="0"
    )

    fanclub: Mapped["Fanclub"] = relationship(back_populates="memberships", lazy="raise")


# Aliases for forward-facing code
Community = Fanclub
CommunityMembership = FanclubMembership
