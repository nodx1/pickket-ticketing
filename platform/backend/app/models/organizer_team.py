"""Organizer team member model — org-level + event-level 협업.

org-level (event_id NULL): organizer 가 v2 자체에서 팀원 초대 — owner/manager/viewer
event-level (event_id NOT NULL): go event_organizers 미러 — host/coordinator/sponsor
unique: (organizer_id, event_id, user_id, role) NULLS NOT DISTINCT
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import DateTime, Enum, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class TeamRole(str, PyEnum):
    # org-level (v2 자체)
    OWNER = "owner"
    MANAGER = "manager"
    VIEWER = "viewer"
    # event-level (go event_organizers 미러)
    HOST = "host"
    COORDINATOR = "coordinator"
    SPONSOR = "sponsor"


class OrganizerTeamMember(Base):
    """팀 멤버 — org-level 또는 event-level.

    event_id NULL → organizer 의 자체 팀 (owner/manager/viewer)
    event_id NOT NULL → 특정 event 의 협업자 (host/coordinator/sponsor)
    """

    __tablename__ = "organizer_team_members"
    __table_args__ = (
        # NULLS NOT DISTINCT 는 raw DDL 로 마이그레이션에서 처리 (PG 15+).
        # SQLAlchemy 측에서는 구조만 선언.
        UniqueConstraint(
            "organizer_id",
            "event_id",
            "user_id",
            "role",
            name="uq_organizer_team_event_user_role",
            postgresql_nulls_not_distinct=True,
        ),
        Index("idx_organizer_team_organizer", "organizer_id"),
        Index("idx_organizer_team_user", "user_id"),
        Index("idx_organizer_team_event", "event_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=True
    )
    role: Mapped[TeamRole] = mapped_column(
        Enum(TeamRole, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20),
        default=TeamRole.VIEWER,
        nullable=False,
    )
    invited_email: Mapped[str] = mapped_column(String(255), nullable=False)
    display_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    go_event_organizer_id: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
