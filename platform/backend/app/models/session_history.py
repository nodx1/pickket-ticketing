import uuid

from sqlalchemy import String, Integer, Boolean, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.types import Money


class SessionHistoryModel(Base):
    __tablename__ = "session_history"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    artist_id: Mapped[str] = mapped_column(String(100), nullable=False)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    session_number: Mapped[int] = mapped_column(Integer, nullable=False)
    participated: Mapped[bool] = mapped_column(Boolean, default=True)
    won: Mapped[bool] = mapped_column(Boolean, default=False)
    tier_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="SET NULL"), nullable=True
    )
    price_paid: Mapped[float] = mapped_column(Money, default=0.0)

    __table_args__ = (UniqueConstraint("user_id", "event_id", name="uq_session_user_event"),)
