"""수수료 스케줄 모델 — 계약별 수수료 + 변경 이력 추적."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, ForeignKey, DateTime, Text, Numeric, Index, CheckConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class FeeSchedule(Base):
    __tablename__ = "fee_schedules"
    __table_args__ = (
        Index("idx_fee_schedule_organizer", "organizer_id"),
        Index("idx_fee_schedule_event", "event_id"),
        Index("idx_fee_schedule_effective", "effective_from", "effective_until"),
        CheckConstraint(
            "fee_type IN ('percentage', 'fixed', 'percentage_plus_fixed')",
            name="ck_fee_schedules_fee_type_valid",
        ),
        # dev_v3 마이그 pgfee1_0723 와 바이트 일치 — provider 값도메인 게이트.
        CheckConstraint(
            "pg_provider IS NULL OR pg_provider IN ('toss', 'nicepay')",
            name="ck_fee_schedules_pg_provider_valid",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organizer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="SET NULL"), nullable=True
    )

    # NULL organizer + NULL event = 플랫폼 기본 수수료
    # organizer만 있으면 = 주최자별 수수료
    # event도 있으면 = 이벤트별 수수료 (최우선)

    platform_fee_rate: Mapped[float] = mapped_column(Numeric(5, 4), nullable=False)  # 0.0500 = 5%
    pg_fee_rate: Mapped[float] = mapped_column(Numeric(5, 4), default=0.0250, nullable=False)

    # SPEC §2.7 — go fee 구조(정률+정액) 미러. fee_type 별로 platform/pg fee 산정:
    #   percentage           : total * rate
    #   fixed                : fixed (정액만)
    #   percentage_plus_fixed: total * rate + fixed  (go 기본 = 3% + ₩300)
    # 동결 시 order.platform_fee 는 정액 포함 절대금액 → 정산 SUM 이 정액까지 포착.
    fee_type: Mapped[str] = mapped_column(
        String(30), nullable=False, server_default="percentage", default="percentage"
    )
    platform_fee_fixed: Mapped[float] = mapped_column(
        Numeric(12, 2), nullable=False, server_default="0", default=0
    )
    pg_fee_fixed: Mapped[float] = mapped_column(
        Numeric(12, 2), nullable=False, server_default="0", default=0
    )

    # 멀티PG provider별 pg fee 동결(dev_v3 계약 (3), 마이그 pgfee1_0723).
    #   NULL          = provider 무관 기본요율(하위호환 — 기존 전 주문·전 스케줄).
    #   'toss'/'nicepay' = 해당 provider 전용 pg_fee_rate/pg_fee_fixed 오버라이드.
    # 선택 규칙(payment_service._freeze_order_fees): 같은 event/organizer effective
    # 구간에서 provider 매치행 우선(ORDER BY (pg_provider = :provider) DESC NULLS LAST)
    # → 없으면 NULL 기본행. platform_fee_rate 는 어느 행이든 동일, pg_fee 만 provider별.
    pg_provider: Mapped[str | None] = mapped_column(String(20), nullable=True)

    effective_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    effective_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # 변경 추적
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    change_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    superseded_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("fee_schedules.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
