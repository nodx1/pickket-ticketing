"""P2-14: Moderation queue model.

Stores flagged content items for admin review.
"""

import uuid
import enum
from datetime import datetime, timezone

from sqlalchemy import DateTime, Enum as SAEnum, ForeignKey, Float, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ModerationContentType(str, enum.Enum):
    REVIEW = "review"
    COMMENT = "comment"
    MESSAGE = "message"


class ModerationStatus(str, enum.Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class ModerationQueue(Base):
    __tablename__ = "moderation_queue"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    content_type: Mapped[ModerationContentType] = mapped_column(
        SAEnum(ModerationContentType, values_callable=lambda e: [x.value for x in e], name="moderation_content_type_enum"),
        nullable=False,
        index=True,
    )
    content_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    content_text: Mapped[str] = mapped_column(Text, nullable=False)
    author_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    flag_reason: Mapped[str] = mapped_column(Text, nullable=False)
    flag_confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    flag_action: Mapped[str] = mapped_column(
        String(10), nullable=False, default="flag"
    )
    status: Mapped[ModerationStatus] = mapped_column(
        SAEnum(ModerationStatus, values_callable=lambda e: [x.value for x in e], name="moderation_status_enum"),
        nullable=False,
        default=ModerationStatus.PENDING,
        index=True,
    )
    reviewer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reviewer_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
