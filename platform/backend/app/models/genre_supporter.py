"""Genre supporter model for domain-specific fan recognition (WP18).

Users who attend 3+ events in a specific domain (e.g. musical, classical)
automatically become Genre Supporters and receive 500 AP bonus.
Genre supporters get the same fanclub weight bonus in lottery draws.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class GenreSupporter(Base):
    """Tracks a user's genre supporter status for a specific domain."""

    __tablename__ = "genre_supporters"
    __table_args__ = (
        UniqueConstraint("user_id", "domain", name="uq_genre_supporter_user_domain"),
        Index("idx_genre_supporter_user_domain", "user_id", "domain"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    domain: Mapped[str] = mapped_column(String(50), nullable=False)
    attendance_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_qualified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    qualified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ap_rewarded: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
