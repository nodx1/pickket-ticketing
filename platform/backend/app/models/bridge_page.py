"""브릿지 페이지(Bridge Page) 모델.

주최자가 여러 이벤트를 묶어 홍보할 수 있는 커스텀 랜딩 페이지.
고유 slug를 통해 접근하며, 복수 이벤트를 하나의 페이지에서 소개한다.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Boolean, DateTime, ForeignKey, Text, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class BridgePage(Base):
    __tablename__ = "bridge_pages"
    __table_args__ = (
        Index("idx_bridge_pages_slug", "slug"),
        Index("idx_bridge_pages_is_active", "is_active"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    slug: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    # JSON array of event UUIDs
    event_ids: Mapped[str] = mapped_column(Text, nullable=False)
    # JSON array of image URLs
    images: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
