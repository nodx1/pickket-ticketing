"""P2-1: AI Agent Delegation Token model."""

import uuid
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    text,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

# 단계6-B (G): DB는 JSONB인데 모델이 plain JSON 선언 → drift. 표준 variant로 정합.
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class DelegationToken(Base):
    __tablename__ = "delegation_tokens"
    __table_args__ = (
        Index(
            "idx_delegation_token_user_active",
            "user_id",
            "is_active",
        ),
        Index(
            "idx_delegation_token_active_lookup",
            "user_id",
            postgresql_where=text("is_active = true AND revoked_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    agent_name: Mapped[str] = mapped_column(
        String(100), nullable=False, comment="Name of the AI agent (e.g. 'ticketing-bot')"
    )
    scopes: Mapped[list] = mapped_column(
        _JSON_TYPE, nullable=False, default=list,
        comment='Allowed scopes: ["view","bid","purchase","manage"]',
    )
    max_budget: Mapped[Decimal | None] = mapped_column(
        Numeric(12, 2), nullable=True,
        comment="Maximum total spend allowed (KRW)",
    )
    daily_limit: Mapped[int | None] = mapped_column(
        Integer, nullable=True,
        comment="Maximum number of transactions per day",
    )
    total_spent: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False, default=Decimal("0"),
        comment="Cumulative spend via this token",
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True,
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    last_used_ip: Mapped[str | None] = mapped_column(
        String(45), nullable=True,
        comment="Last IP address used with this token (for geo-anomaly)",
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )

    user: Mapped["User"] = relationship(back_populates="delegation_tokens", lazy="raise")  # noqa: F821
