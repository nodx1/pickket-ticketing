import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import Integer, BigInteger, Float, ForeignKey, Enum, DateTime, Boolean, String, UniqueConstraint, Index
from sqlalchemy.types import JSON
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class LotteryPoolStatus(str, PyEnum):
    OPEN = "open"
    CLOSED = "closed"
    DRAWN = "drawn"


class LotteryEntryResult(str, PyEnum):
    PENDING = "pending"
    WON = "won"
    WAITLISTED = "waitlisted"


class LotteryPool(Base):
    __tablename__ = "lottery_pools"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    tier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="RESTRICT"), nullable=False
    )
    total_seats: Mapped[int] = mapped_column(Integer, nullable=False)
    use_fan_weight: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[LotteryPoolStatus] = mapped_column(
        Enum(LotteryPoolStatus, values_callable=lambda e: [x.value for x in e]), default=LotteryPoolStatus.OPEN
    )
    seed_used: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    commitment_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    verification_data: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    # ── Commit-reveal v2 (F-1) ──
    # server_seed: 추첨 전 생성·비공개 보관, 추첨(DRAWN) 후에만 공개(reveal).
    #   DRAWN 이전에는 어떤 API 응답에도 노출 금지.
    # seed_commitment: H(domain‖pool_id‖server_seed) — 풀 생성/마감 시점에
    #   영속화되는 사전 커밋. 공개 조회 가능. draw 는 이 커밋의 seed 만 사용.
    # committed_at / drawn_at: 커밋이 추첨보다 선행했음을 증명하는 타임스탬프.
    server_seed: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    seed_commitment: Mapped[str | None] = mapped_column(String(64), nullable=True)
    committed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    drawn_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    entries: Mapped[list["LotteryEntry"]] = relationship(back_populates="pool", lazy="raise")


class LotteryEntry(Base):
    __tablename__ = "lottery_entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pool_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("lottery_pools.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    group_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    group_size: Mapped[int] = mapped_column(Integer, default=1)
    fan_weight: Mapped[float] = mapped_column(Float, default=1.0)
    client_seed: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # WP12: AP 투자 기반 가중 추첨 (POINT_LOTTERY)
    invested_ap: Mapped[int] = mapped_column(Integer, default=0)
    tier_multiplier: Mapped[float] = mapped_column(Float, default=1.0)
    pity_bonus: Mapped[float] = mapped_column(Float, default=1.0)
    amendment_count: Mapped[int] = mapped_column(Integer, default=0)  # AP 수정 횟수 (최대 3회)
    result: Mapped[LotteryEntryResult] = mapped_column(
        Enum(LotteryEntryResult, values_callable=lambda e: [x.value for x in e]), default=LotteryEntryResult.PENDING
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    pool: Mapped["LotteryPool"] = relationship(back_populates="entries", lazy="raise")

    __table_args__ = (
        UniqueConstraint("pool_id", "user_id", name="uq_lottery_pool_user"),
        Index("idx_lottery_entry_pool_user", "pool_id", "user_id"),
    )
