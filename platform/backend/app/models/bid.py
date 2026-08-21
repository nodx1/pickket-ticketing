import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import CheckConstraint, Integer, Float, String, DateTime, ForeignKey, Enum, Index, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.types import Money


class BidStatus(str, PyEnum):
    ACTIVE = "active"
    CANCELLED = "cancelled"
    WON = "won"
    LOST = "lost"
    REJECTED = "rejected"  # anomaly detected


class Bid(Base):
    __tablename__ = "bids"
    __table_args__ = (
        Index("idx_bid_event_status", "event_id", "status"),
        # P0-11: hotpath composite index
        Index("idx_bid_user_event", "user_id", "event_id"),
        # idx11: 동일 사용자가 같은 이벤트에 ACTIVE 입찰을 둘 이상 가질 수 없다.
        # 부분 유니크 인덱스(status='active' WHERE 절)로 동시 INSERT 의 TOCTOU
        # 중복을 DB 레벨에서 차단 — create_bid 의 IntegrityError 핸들러를 뒷받침한다.
        # (CANCELLED/WON/LOST/REJECTED 는 이력으로 다수 허용)
        Index(
            "uq_bid_user_event_active",
            "user_id",
            "event_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
            sqlite_where=text("status = 'active'"),
        ),
        CheckConstraint("max_willingness_to_pay > 0", name="ck_bids_max_wtp_positive"),
        CheckConstraint("quantity > 0", name="ck_bids_quantity_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )

    max_willingness_to_pay: Mapped[float] = mapped_column(Money, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, default=1)

    tier_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="SET NULL"), nullable=True
    )

    # Computed at allocation time
    effective_weight: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Amendment tracking
    amendment_count: Mapped[int] = mapped_column(Integer, default=0)
    last_amended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Anomaly detection
    anomaly_score: Mapped[float] = mapped_column(Float, default=0.0)
    anomaly_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)

    status: Mapped[BidStatus] = mapped_column(
        Enum(BidStatus, values_callable=lambda e: [x.value for x in e]), default=BidStatus.ACTIVE, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    user: Mapped["User"] = relationship(back_populates="bids", lazy="raise")  # noqa: F821
    event: Mapped["Event"] = relationship(back_populates="bids", lazy="raise")  # noqa: F821
