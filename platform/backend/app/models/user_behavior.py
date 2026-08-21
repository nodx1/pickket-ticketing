"""User behavior tracking model — P1-5 behavior tracking infrastructure.

Captures granular user actions (page views, searches, bids, purchases, etc.)
for downstream features: recommendations (P2-4), cohorts (P2-12),
scalping detection (P3-5), fraud detection (P3-6).
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Index, String, Text, ForeignKey, DateTime, JSON
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class UserBehavior(Base):
    __tablename__ = "user_behaviors"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    session_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(30), nullable=False)
    target_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    target_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True,
    )
    metadata_json: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False),
        nullable=False,
        default=lambda: datetime.now(timezone.utc).replace(tzinfo=None),
    )

    __table_args__ = (
        Index("ix_ub_user_created", "user_id", "created_at"),
        Index("ix_ub_event_target_created", "event_type", "target_type", "created_at"),
        Index("ix_ub_target_event", "target_id", "event_type"),
    )
