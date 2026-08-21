import uuid
import enum
from datetime import datetime, timezone

from sqlalchemy import String, Text, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class InteractionType(str, enum.Enum):
    VIEW = "VIEW"
    FAVORITE = "FAVORITE"
    UNFAVORITE = "UNFAVORITE"
    BID = "BID"
    SEARCH = "SEARCH"


class UserInteraction(Base):
    __tablename__ = "user_interactions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="SET NULL"), nullable=True
    )
    interaction_type: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    metadata_json: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )  # JSON string for SQLite compat
    created_at: Mapped[datetime] = mapped_column(
        default=lambda: datetime.now(timezone.utc).replace(tzinfo=None)
    )
