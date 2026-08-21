"""Billing key model for saved card (one-click) payments."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Boolean, ForeignKey, DateTime, Index, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class BillingKey(Base):
    __tablename__ = "billing_keys"
    __table_args__ = (
        Index(
            "idx_billing_key_user_default",
            "user_id",
            "is_default",
        ),
        Index(
            "uq_billing_key_active_default",
            "user_id",
            unique=True,
            postgresql_where=text("is_default = true AND deactivated_at IS NULL"),
        ),
        Index("idx_billing_key_user_active", "user_id", postgresql_where=text("deactivated_at IS NULL")),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    billing_key: Mapped[str] = mapped_column(
        String(512), nullable=False, comment="Fernet-encrypted PortOne billing key"
    )
    card_type: Mapped[str] = mapped_column(
        String(20), nullable=False, comment="credit / debit / prepaid"
    )
    last_four: Mapped[str] = mapped_column(
        String(4), nullable=False, comment="Last four digits of card number"
    )
    card_brand: Mapped[str] = mapped_column(
        String(30), nullable=False, comment="VISA, MASTERCARD, AMEX, etc."
    )
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    nickname: Mapped[str | None] = mapped_column(
        String(50), nullable=True, comment="User-defined card nickname"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    deactivated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    user: Mapped["User"] = relationship(back_populates="billing_keys", lazy="raise")  # noqa: F821
