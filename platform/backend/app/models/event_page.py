"""Event page model — subdomain landing page config (1:1 with Event).

Separated from Event model to avoid bloating the 80+ field table.
Stores subdomain slug, Puck page builder JSON, and theme customization.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class EventPage(Base):
    __tablename__ = "event_pages"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("events.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    subdomain_slug: Mapped[str] = mapped_column(
        String(100), nullable=False, unique=True, index=True
    )
    page_template: Mapped[str | None] = mapped_column(
        String(50), nullable=True
    )  # concert, festival, exhibition, conference, fanmeeting
    page_data: Mapped[dict | None] = mapped_column(
        JSON, nullable=True
    )  # Puck JSON blob (legacy)
    sections: Mapped[list | None] = mapped_column(
        JSON, nullable=True
    )  # Page builder sections — ordered list of section blocks
    page_theme: Mapped[dict | None] = mapped_column(
        JSON, nullable=True
    )  # Custom colors/fonts
    page_published: Mapped[bool] = mapped_column(Boolean, default=False)
    white_label: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    white_label_config: Mapped[dict | None] = mapped_column(
        JSON, nullable=True
    )  # Custom footer text, powered-by text, links etc.
    published_at: Mapped[datetime | None] = mapped_column(
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
