"""Admin settlement dashboard schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel


# ── Settlement list / detail ─────────────────────────────────────


class AdminSettlementItem(BaseModel):
    id: uuid.UUID
    organizer_id: uuid.UUID
    organizer_name: str
    organizer_email: str | None = None
    period_start: datetime
    period_end: datetime
    gross_revenue: float
    refund_amount: float
    platform_fee: float
    pg_fee: float
    net_settlement: float
    status: str
    fee_schedule_id: uuid.UUID | None = None
    reviewed_by: uuid.UUID | None = None
    reviewed_at: datetime | None = None
    approved_by: uuid.UUID | None = None
    approved_at: datetime | None = None
    paid_at: datetime | None = None
    dispute_reason: str | None = None
    created_at: datetime


class AdminSettlementListResponse(BaseModel):
    settlements: list[AdminSettlementItem]
    total: int


class AdminSettlementDetailResponse(AdminSettlementItem):
    """Detail response with extra info."""
    fee_rate: float | None = None
    pg_fee_rate: float | None = None
    adjustments: list["SettlementAdjustmentItem"] = []
    reviewer_name: str | None = None
    approver_name: str | None = None


# ── Summary ──────────────────────────────────────────────────────


class SettlementSummaryResponse(BaseModel):
    total_pending: int
    total_pending_amount: float
    total_reviewed: int
    total_reviewed_amount: float
    total_approved: int
    total_approved_amount: float
    total_paid: int
    total_paid_amount: float
    total_disputed: int
    this_month_count: int
    this_month_amount: float


# ── Status update ────────────────────────────────────────────────


class SettlementStatusUpdate(BaseModel):
    action: str  # "hold", "release", "dispute", "mark_paid"
    reason: str = ""


# ── Manual adjustment ────────────────────────────────────────────


class SettlementAdjustmentCreate(BaseModel):
    amount: float
    reason: str
    adjustment_type: str = "manual"  # manual, correction, penalty, bonus


class SettlementAdjustmentItem(BaseModel):
    id: uuid.UUID
    settlement_id: uuid.UUID
    amount: float
    reason: str
    adjustment_type: str
    created_by: uuid.UUID | None = None  # NULL = 시스템 자동 생성 (클로백 등)
    created_by_name: str | None = None
    created_at: datetime
    status: str = "applied"  # pending_approval, applied, rejected
    applied: bool = True
    approved_by: uuid.UUID | None = None
    approved_at: datetime | None = None


class SettlementAdjustmentListResponse(BaseModel):
    adjustments: list[SettlementAdjustmentItem]
    total: int


# Resolve forward references
AdminSettlementDetailResponse.model_rebuild()
