"""정산 모델 — OrganizerSettlement 이중 승인 체인."""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import Boolean, CheckConstraint, String, ForeignKey, DateTime, Text, Numeric, Index, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SettlementStatus(str, PyEnum):
    DRAFT = "draft"
    PENDING_REVIEW = "pending_review"
    REVIEWED = "reviewed"
    APPROVED = "approved"
    PAID = "paid"
    DISPUTED = "disputed"


class SettlementType(str, PyEnum):
    """정산 수취 주체 구분 (블로커 #6 — 재판매 판매자 정산 분리)."""

    ORGANIZER = "organizer"          # 주최자 1차 판매 정산
    RESALE_SELLER = "resale_seller"  # 재판매 판매자(seller_receives) 정산


class OrganizerSettlement(Base):
    __tablename__ = "organizer_settlements"
    __table_args__ = (
        Index("idx_settlement_organizer", "organizer_id"),
        Index("idx_settlement_status", "status"),
        Index("idx_settlement_period", "period_start", "period_end"),
        # (organizer, period, type) 멱등 + 동시성 중복 INSERT 차단.
        # 활성(deleted_at IS NULL) row 만 UNIQUE — 소프트 삭제 후 동일 키 재생성 허용.
        # 동시 generate_settlements 2회가 같은 정산 row 를 INSERT 하면 DB 가 차단.
        Index(
            "uq_settlement_org_period_type",
            "organizer_id", "period_start", "period_end", "settlement_type",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
            sqlite_where=text("deleted_at IS NULL"),
        ),
        # DB reconcile: 기존 DB 인덱스 모델 선언 동기화
        Index("ix_settlements_not_deleted", "id", postgresql_where=text("deleted_at IS NULL")),
        CheckConstraint(
            "status IN ('draft', 'pending_review', 'reviewed', 'approved', 'paid', 'disputed')",
            name="ck_organizer_settlements_status",
        ),
        CheckConstraint(
            "settlement_type IN ('organizer', 'resale_seller')",
            name="ck_organizer_settlements_type",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # settlement_type='resale_seller' 인 경우 판매자(user) id — 컬럼명은 호환 유지.
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    settlement_type: Mapped[str] = mapped_column(
        String(20), default="organizer", server_default="organizer", nullable=False
    )

    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    gross_revenue: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False)
    total_refunds: Mapped[float] = mapped_column(Numeric(14, 2), default=0, nullable=False)
    platform_fee: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False)
    pg_fee: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False)
    net_payout: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False)
    # 클로백 누계 (블로커 #4) — 이 정산 기간 주문에서 정산 생성 "이후" 발생한
    # 환불·차지백이 다음 주기 정산에서 차감(clawback)된 누적액.
    # 불변식: total_refunds + refunds_clawed == 현재 시점 해당 기간의 환불등가액.
    # NULL = 클로백 도입 이전(legacy) 정산 → 클로백 스캔 대상에서 제외(수동 조정 필요).
    refunds_clawed: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)

    fee_schedule_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("fee_schedules.id", ondelete="SET NULL"), nullable=True
    )

    status: Mapped[str] = mapped_column(String(20), default="draft", nullable=False)

    # 이중 승인 체인
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    dispute_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    reconciliation_batch_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )

    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class SettlementAdjustment(Base):
    """정산 수동 조정 이력."""

    __tablename__ = "settlement_adjustments"
    __table_args__ = (
        Index("idx_adj_settlement", "settlement_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    settlement_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizer_settlements.id", ondelete="RESTRICT"), nullable=False
    )
    amount: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    adjustment_type: Mapped[str] = mapped_column(
        String(20), default="manual", nullable=False
    )  # manual, correction, penalty, bonus, clawback, resale_royalty
    # NULL = 시스템(settlement_generate 클로백 등) 자동 생성
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    # 4-eyes 통제 (M-3): 수동 조정은 작성자≠승인자 승인 후에만 net_payout 에 반영된다.
    # 시스템 자동 조정(created_by NULL)은 생성 시점에 즉시 applied=True 로 기록된다.
    status: Mapped[str] = mapped_column(
        String(20), default="applied", nullable=False, server_default=text("'applied'")
    )  # pending_approval, applied, rejected
    applied: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False, server_default=text("true")
    )
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
