import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import (
    Integer,
    Float,
    String,
    DateTime,
    ForeignKey,
    Enum,
    Index,
    JSON,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.types import Money

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class AllocationStatus(str, PyEnum):
    PENDING = "pending"
    COMPUTING = "computing"
    COMPLETED = "completed"
    FAILED = "failed"


class Allocation(Base):
    __tablename__ = "allocations"
    __table_args__ = (
        UniqueConstraint("event_id", "tier_id", name="uq_allocation_event_tier"),
        # 이벤트 단위 배분(run_allocation_async)은 tier_id=NULL 로 생성되는데,
        # PostgreSQL 은 NULL 을 distinct 로 취급해 위 복합 unique 가 안 걸린다.
        # tier_id IS NULL 행에 대한 부분 unique 인덱스로 이벤트당 1건을 DB 가 보장 (C-2).
        # SQLite 도 partial index 를 지원하므로 테스트(create_all)에서도 동일하게 강제된다.
        Index(
            "uq_allocation_event_null_tier",
            "event_id",
            unique=True,
            postgresql_where=text("tier_id IS NULL"),
            sqlite_where=text("tier_id IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )

    status: Mapped[AllocationStatus] = mapped_column(
        Enum(AllocationStatus, values_callable=lambda e: [x.value for x in e]), default=AllocationStatus.PENDING
    )

    total_bids: Mapped[int] = mapped_column(Integer, default=0)
    total_allocated: Mapped[int] = mapped_column(Integer, default=0)
    competition_ratio: Mapped[float] = mapped_column(Float, default=0.0)

    # Price distribution
    price_min: Mapped[float | None] = mapped_column(Money, nullable=True)
    price_max: Mapped[float | None] = mapped_column(Money, nullable=True)
    price_median: Mapped[float | None] = mapped_column(Money, nullable=True)
    price_p25: Mapped[float | None] = mapped_column(Money, nullable=True)
    price_p75: Mapped[float | None] = mapped_column(Money, nullable=True)
    cutoff_price: Mapped[float | None] = mapped_column(Money, nullable=True)

    # Tier & pool
    tier_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="SET NULL"), nullable=True
    )
    pool: Mapped[str | None] = mapped_column(String(10), nullable=True)

    # Fairness metrics
    gini_coefficient: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Behavioral metrics
    overbidding_indicator: Mapped[float | None] = mapped_column(Float, nullable=True)
    total_consumer_surplus: Mapped[float | None] = mapped_column(Money, nullable=True)
    weight_price_correlation: Mapped[float | None] = mapped_column(Float, nullable=True)
    collusion_signal_score: Mapped[float] = mapped_column(Float, default=0.0)
    lottery_seed: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Metadata
    computation_time_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    anomalies_blocked: Mapped[int] = mapped_column(Integer, default=0)
    engine_params: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    event: Mapped["Event"] = relationship(back_populates="allocation", lazy="raise")  # noqa: F821
    results: Mapped[list["AllocationResult"]] = relationship(back_populates="allocation", lazy="raise")


class AllocationResult(Base):
    __tablename__ = "allocation_results"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    allocation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("allocations.id", ondelete="CASCADE"), nullable=False
    )
    bid_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("bids.id", ondelete="RESTRICT"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )

    vcg_price: Mapped[float] = mapped_column(Money, nullable=False)
    final_price: Mapped[float] = mapped_column(Money, nullable=False)
    externality: Mapped[float] = mapped_column(Money, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    allocation: Mapped["Allocation"] = relationship(back_populates="results", lazy="raise")
