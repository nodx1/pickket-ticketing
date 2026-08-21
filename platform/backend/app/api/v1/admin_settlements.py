"""Admin Settlement Dashboard API — P1-12."""

import csv
import io
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import write_audit_log
from app.core.database import get_db, get_read_db
from app.core.errors import client_error_detail
from app.middleware.auth import require_scope
from app.models.fee_schedule import FeeSchedule
from app.models.settlement import (
    OrganizerSettlement,
    SettlementAdjustment,
    SettlementStatus,
)
from app.models.user import User
from app.schemas.settlement_admin import (
    AdminSettlementItem,
    AdminSettlementListResponse,
    AdminSettlementDetailResponse,
    SettlementSummaryResponse,
    SettlementStatusUpdate,
    SettlementAdjustmentCreate,
    SettlementAdjustmentItem,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ════════════════════════════════════════════════════════════════════
# List settlements (paginated, filterable)
# ════════════════════════════════════════════════════════════════════


@router.get("/admin/settlements", response_model=AdminSettlementListResponse)
async def list_settlements(
    status: str | None = Query(None, description="Filter by status"),
    organizer_id: uuid.UUID | None = Query(None),
    date_from: str | None = Query(None, description="YYYY-MM-DD"),
    date_to: str | None = Query(None, description="YYYY-MM-DD"),
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    admin: User = Depends(require_scope("finance.view")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: list all settlements with filters."""
    query = (
        select(OrganizerSettlement, User.name, User.email)
        .join(User, User.id == OrganizerSettlement.organizer_id)
    )
    count_query = (
        select(func.count(OrganizerSettlement.id))
    )

    filters = []
    if status:
        filters.append(OrganizerSettlement.status == status)
    if organizer_id:
        filters.append(OrganizerSettlement.organizer_id == organizer_id)
    if date_from:
        try:
            dt_from = datetime.fromisoformat(date_from)
            filters.append(OrganizerSettlement.period_start >= dt_from)
        except ValueError:
            logger.debug("invalid settlement date_from filter: %s", date_from, exc_info=True)
    if date_to:
        try:
            dt_to = datetime.fromisoformat(date_to)
            filters.append(OrganizerSettlement.period_end <= dt_to)
        except ValueError:
            logger.debug("invalid settlement date_to filter: %s", date_to, exc_info=True)

    if filters:
        query = query.where(and_(*filters))
        count_query = count_query.where(and_(*filters))

    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    query = query.order_by(OrganizerSettlement.created_at.desc()).offset(skip).limit(limit)
    result = await db.execute(query)
    rows = result.all()

    settlements = []
    for settlement, organizer_name, organizer_email in rows:
        settlements.append(
            AdminSettlementItem(
                id=settlement.id,
                organizer_id=settlement.organizer_id,
                organizer_name=organizer_name or "Unknown",
                organizer_email=organizer_email,
                period_start=settlement.period_start,
                period_end=settlement.period_end,
                gross_revenue=float(settlement.gross_revenue),
                refund_amount=float(settlement.total_refunds),
                platform_fee=float(settlement.platform_fee),
                pg_fee=float(settlement.pg_fee),
                net_settlement=float(settlement.net_payout),
                status=settlement.status,
                fee_schedule_id=settlement.fee_schedule_id,
                reviewed_by=settlement.reviewed_by,
                reviewed_at=settlement.reviewed_at,
                approved_by=settlement.approved_by,
                approved_at=settlement.approved_at,
                paid_at=settlement.paid_at,
                dispute_reason=settlement.dispute_reason,
                created_at=settlement.created_at,
            )
        )

    return AdminSettlementListResponse(settlements=settlements, total=total)


# ════════════════════════════════════════════════════════════════════
# Settlement detail
# ════════════════════════════════════════════════════════════════════


@router.get("/admin/settlements/summary", response_model=SettlementSummaryResponse)
async def settlement_summary(
    admin: User = Depends(require_scope("finance.view")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: aggregate settlement stats."""
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    # Status aggregation
    status_query = select(
        OrganizerSettlement.status,
        func.count(OrganizerSettlement.id).label("cnt"),
        func.coalesce(func.sum(OrganizerSettlement.net_payout), 0).label("total_amount"),
    ).group_by(OrganizerSettlement.status)

    result = await db.execute(status_query)
    status_rows = result.all()

    stats = {
        "total_pending": 0,
        "total_pending_amount": 0.0,
        "total_reviewed": 0,
        "total_reviewed_amount": 0.0,
        "total_approved": 0,
        "total_approved_amount": 0.0,
        "total_paid": 0,
        "total_paid_amount": 0.0,
        "total_disputed": 0,
    }

    pending_statuses = {SettlementStatus.DRAFT, SettlementStatus.PENDING_REVIEW}
    for status_val, cnt, amount in status_rows:
        if status_val in {s.value for s in pending_statuses} or status_val in pending_statuses:
            stats["total_pending"] += cnt
            stats["total_pending_amount"] += float(amount)
        elif status_val == SettlementStatus.REVIEWED or status_val == SettlementStatus.REVIEWED.value:
            stats["total_reviewed"] = cnt
            stats["total_reviewed_amount"] = float(amount)
        elif status_val == SettlementStatus.APPROVED or status_val == SettlementStatus.APPROVED.value:
            stats["total_approved"] = cnt
            stats["total_approved_amount"] = float(amount)
        elif status_val == SettlementStatus.PAID or status_val == SettlementStatus.PAID.value:
            stats["total_paid"] = cnt
            stats["total_paid_amount"] = float(amount)
        elif status_val == SettlementStatus.DISPUTED or status_val == SettlementStatus.DISPUTED.value:
            stats["total_disputed"] = cnt

    # This month
    month_result = await db.execute(
        select(
            func.count(OrganizerSettlement.id),
            func.coalesce(func.sum(OrganizerSettlement.net_payout), 0),
        ).where(OrganizerSettlement.created_at >= month_start)
    )
    month_row = month_result.one()
    stats["this_month_count"] = month_row[0] or 0
    stats["this_month_amount"] = float(month_row[1] or 0)

    return SettlementSummaryResponse(**stats)


# ════════════════════════════════════════════════════════════════════
# CSV export (must be before {settlement_id} route)
# ════════════════════════════════════════════════════════════════════


@router.get("/admin/settlements/export")
async def export_settlements(
    status: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    admin: User = Depends(require_scope("finance.view")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: export settlements as CSV."""
    query = (
        select(OrganizerSettlement, User.name, User.email)
        .join(User, User.id == OrganizerSettlement.organizer_id)
    )

    filters = []
    if status:
        filters.append(OrganizerSettlement.status == status)
    if date_from:
        try:
            filters.append(OrganizerSettlement.period_start >= datetime.fromisoformat(date_from))
        except ValueError:
            logger.debug("invalid settlement export date_from filter: %s", date_from, exc_info=True)
    if date_to:
        try:
            filters.append(OrganizerSettlement.period_end <= datetime.fromisoformat(date_to))
        except ValueError:
            logger.debug("invalid settlement export date_to filter: %s", date_to, exc_info=True)

    if filters:
        query = query.where(and_(*filters))

    _EXPORT_LIMIT = 10_000  # 안전 상한 — CSV 메모리 폭주 방지
    query = query.order_by(OrganizerSettlement.created_at.desc()).limit(_EXPORT_LIMIT)
    result = await db.execute(query)
    rows = result.all()

    output = io.StringIO()
    output.write("\ufeff")  # BOM for Excel
    writer = csv.writer(output)
    writer.writerow([
        "정산ID", "주최자명", "주최자이메일", "정산시작", "정산종료",
        "총매출", "환불액", "플랫폼수수료", "PG수수료", "순지급액", "상태", "생성일",
    ])

    status_labels = {
        "draft": "초안",
        "pending_review": "검토대기",
        "reviewed": "검토완료",
        "approved": "승인됨",
        "paid": "지급완료",
        "disputed": "이의제기",
    }

    for settlement, name, email in rows:
        writer.writerow([
            str(settlement.id),
            name or "",
            email or "",
            settlement.period_start.strftime("%Y-%m-%d") if settlement.period_start else "",
            settlement.period_end.strftime("%Y-%m-%d") if settlement.period_end else "",
            float(settlement.gross_revenue),
            float(settlement.total_refunds),
            float(settlement.platform_fee),
            float(settlement.pg_fee),
            float(settlement.net_payout),
            status_labels.get(settlement.status, settlement.status),
            settlement.created_at.strftime("%Y-%m-%d %H:%M") if settlement.created_at else "",
        ])

    output.seek(0)
    filename = f"settlements_{datetime.now(timezone.utc).strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ════════════════════════════════════════════════════════════════════
# Settlement detail
# ════════════════════════════════════════════════════════════════════


@router.get("/admin/settlements/{settlement_id}", response_model=AdminSettlementDetailResponse)
async def settlement_detail(
    settlement_id: uuid.UUID,
    admin: User = Depends(require_scope("finance.view")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: settlement detail with adjustments."""
    result = await db.execute(
        select(OrganizerSettlement, User.name, User.email)
        .join(User, User.id == OrganizerSettlement.organizer_id)
        .where(OrganizerSettlement.id == settlement_id)
    )
    row = result.one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Settlement not found")

    settlement, organizer_name, organizer_email = row

    # Load fee schedule info
    fee_rate = None
    pg_fee_rate = None
    if settlement.fee_schedule_id:
        fee_result = await db.execute(
            select(FeeSchedule).where(FeeSchedule.id == settlement.fee_schedule_id)
        )
        fee_schedule = fee_result.scalar_one_or_none()
        if fee_schedule:
            fee_rate = float(fee_schedule.platform_fee_rate)
            pg_fee_rate = float(fee_schedule.pg_fee_rate)

    # Load reviewer/approver names
    reviewer_name = None
    approver_name = None
    if settlement.reviewed_by:
        r = await db.execute(select(User.name).where(User.id == settlement.reviewed_by))
        reviewer_name = r.scalar_one_or_none()
    if settlement.approved_by:
        r = await db.execute(select(User.name).where(User.id == settlement.approved_by))
        approver_name = r.scalar_one_or_none()

    # Load adjustments — 시스템 자동 조정(클로백 등)은 created_by NULL → outerjoin
    adj_result = await db.execute(
        select(SettlementAdjustment, User.name)
        .outerjoin(User, User.id == SettlementAdjustment.created_by)
        .where(SettlementAdjustment.settlement_id == settlement_id)
        .order_by(SettlementAdjustment.created_at.desc())
    )
    adjustments = [
        SettlementAdjustmentItem(
            id=adj.id,
            settlement_id=adj.settlement_id,
            amount=float(adj.amount),
            reason=adj.reason,
            adjustment_type=adj.adjustment_type,
            created_by=adj.created_by,
            created_by_name=adj_name,
            created_at=adj.created_at,
            status=adj.status,
            applied=adj.applied,
            approved_by=adj.approved_by,
            approved_at=adj.approved_at,
        )
        for adj, adj_name in adj_result.all()
    ]

    return AdminSettlementDetailResponse(
        id=settlement.id,
        organizer_id=settlement.organizer_id,
        organizer_name=organizer_name or "Unknown",
        organizer_email=organizer_email,
        period_start=settlement.period_start,
        period_end=settlement.period_end,
        gross_revenue=float(settlement.gross_revenue),
        refund_amount=float(settlement.total_refunds),
        platform_fee=float(settlement.platform_fee),
        pg_fee=float(settlement.pg_fee),
        net_settlement=float(settlement.net_payout),
        status=settlement.status,
        fee_schedule_id=settlement.fee_schedule_id,
        reviewed_by=settlement.reviewed_by,
        reviewed_at=settlement.reviewed_at,
        approved_by=settlement.approved_by,
        approved_at=settlement.approved_at,
        paid_at=settlement.paid_at,
        dispute_reason=settlement.dispute_reason,
        created_at=settlement.created_at,
        fee_rate=fee_rate,
        pg_fee_rate=pg_fee_rate,
        adjustments=adjustments,
        reviewer_name=reviewer_name,
        approver_name=approver_name,
    )


# ════════════════════════════════════════════════════════════════════
# Status update (hold, release, dispute, mark_paid)
# ════════════════════════════════════════════════════════════════════


@router.patch("/admin/settlements/{settlement_id}")
async def update_settlement_status(
    settlement_id: uuid.UUID,
    data: SettlementStatusUpdate,
    admin: User = Depends(require_scope("settlements.review")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: update settlement status (hold, release, dispute, mark_paid)."""
    result = await db.execute(
        select(OrganizerSettlement)
        .where(OrganizerSettlement.id == settlement_id)
        .with_for_update()
    )
    settlement = result.scalar_one_or_none()
    if not settlement:
        raise HTTPException(status_code=404, detail="Settlement not found")

    action = data.action
    old_status = settlement.status

    if action == "hold":
        settlement.status = SettlementStatus.DISPUTED.value
        settlement.dispute_reason = data.reason or "관리자에 의한 보류"
    elif action == "release":
        if settlement.status not in (SettlementStatus.DISPUTED, SettlementStatus.DISPUTED.value):
            raise HTTPException(status_code=400, detail="보류 상태가 아닙니다.")
        settlement.status = SettlementStatus.PENDING_REVIEW.value
        settlement.dispute_reason = None
    elif action == "dispute":
        settlement.status = SettlementStatus.DISPUTED.value
        settlement.dispute_reason = data.reason
    elif action == "mark_paid":
        if settlement.status not in (SettlementStatus.APPROVED, SettlementStatus.APPROVED.value):
            raise HTTPException(status_code=400, detail="승인 상태에서만 지급 완료 처리 가능합니다.")
        settlement.status = SettlementStatus.PAID.value
        settlement.paid_at = datetime.now(timezone.utc)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown action: {action}")

    await write_audit_log(
        db,
        actor_id=admin.id,
        action=f"settlement.{action}",
        resource_type="settlement",
        resource_id=str(settlement_id),
        old_value={"status": old_status},
        new_value={"status": settlement.status, "reason": data.reason},
    )
    await db.commit()

    return {
        "settlement_id": str(settlement.id),
        "status": settlement.status,
        "action": action,
    }


# ════════════════════════════════════════════════════════════════════
# Manual adjustment
# ════════════════════════════════════════════════════════════════════


# 단일 수동 조정 절대 금액 상한 — 비정상적 대규모 조정 차단(감사 권고).
_MAX_ADJUSTMENT_ABS = Decimal("100000000")  # 1억


@router.post("/admin/settlements/{settlement_id}/adjust")
async def create_adjustment(
    settlement_id: uuid.UUID,
    data: SettlementAdjustmentCreate,
    admin: User = Depends(require_scope("settlements.approve")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: propose a manual adjustment on a settlement.

    4-eyes(M-3): 조정은 즉시 net_payout 에 반영되지 않고 pending_approval 로 기록된다.
    작성자와 다른 admin 의 approve_adjustment 승인 후에야 net_payout 에 적용된다.
    """
    result = await db.execute(
        select(OrganizerSettlement)
        .where(OrganizerSettlement.id == settlement_id)
        .with_for_update()
    )
    settlement = result.scalar_one_or_none()
    if not settlement:
        raise HTTPException(status_code=404, detail="Settlement not found")

    if settlement.status in (SettlementStatus.PAID, SettlementStatus.PAID.value):
        raise HTTPException(status_code=400, detail="지급 완료된 정산은 조정할 수 없습니다.")

    # 금액 검증 — float 입력을 즉시 Decimal 로 고정(부동소수 오차 차단) 후 상·하한 검사.
    amount = Decimal(str(data.amount))
    if amount == 0:
        raise HTTPException(status_code=400, detail="조정 금액은 0이 될 수 없습니다.")
    if abs(amount) > _MAX_ADJUSTMENT_ABS:
        raise HTTPException(
            status_code=400,
            detail=f"조정 금액이 허용 한도(±{_MAX_ADJUSTMENT_ABS})를 초과합니다.",
        )

    adjustment = SettlementAdjustment(
        settlement_id=settlement_id,
        amount=amount,
        reason=data.reason,
        adjustment_type=data.adjustment_type,
        created_by=admin.id,
        status="pending_approval",
        applied=False,
    )
    db.add(adjustment)

    await write_audit_log(
        db,
        actor_id=admin.id,
        action="settlement.adjust_proposed",
        resource_type="settlement",
        resource_id=str(settlement_id),
        new_value={
            "amount": float(amount),
            "reason": data.reason,
            "type": data.adjustment_type,
            "status": "pending_approval",
        },
    )
    await db.commit()
    await db.refresh(adjustment)

    return {
        "adjustment_id": str(adjustment.id),
        "settlement_id": str(settlement_id),
        "amount": float(amount),
        "status": "pending_approval",
        "net_payout": float(settlement.net_payout),  # 변동 없음 — 승인 전
    }


@router.post("/admin/settlements/{settlement_id}/adjust/{adjustment_id}/approve")
async def approve_adjustment(
    settlement_id: uuid.UUID,
    adjustment_id: uuid.UUID,
    admin: User = Depends(require_scope("settlements.approve")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: approve a pending manual adjustment and apply it to net_payout.

    4-eyes(M-3): 승인자는 조정 작성자와 반드시 달라야 한다. 승인 시점에만
    net_payout 이 Decimal 연산으로 갱신된다.
    """
    result = await db.execute(
        select(OrganizerSettlement)
        .where(OrganizerSettlement.id == settlement_id)
        .with_for_update()
    )
    settlement = result.scalar_one_or_none()
    if not settlement:
        raise HTTPException(status_code=404, detail="Settlement not found")

    if settlement.status in (SettlementStatus.PAID, SettlementStatus.PAID.value):
        raise HTTPException(status_code=400, detail="지급 완료된 정산은 조정할 수 없습니다.")

    adj_result = await db.execute(
        select(SettlementAdjustment)
        .where(
            SettlementAdjustment.id == adjustment_id,
            SettlementAdjustment.settlement_id == settlement_id,
        )
        .with_for_update()
    )
    adjustment = adj_result.scalar_one_or_none()
    if not adjustment:
        raise HTTPException(status_code=404, detail="Adjustment not found")
    if adjustment.applied or adjustment.status != "pending_approval":
        raise HTTPException(status_code=400, detail="승인 대기 중인 조정이 아닙니다.")
    if adjustment.created_by == admin.id:
        raise HTTPException(
            status_code=403, detail="조정 작성자는 본인 조정을 승인할 수 없습니다 (4-eyes)."
        )

    # Decimal 연산 — net_payout(Money/Numeric) 정밀도 보존.
    new_net = Decimal(str(settlement.net_payout)) + Decimal(str(adjustment.amount))
    settlement.net_payout = new_net

    adjustment.status = "applied"
    adjustment.applied = True
    adjustment.approved_by = admin.id
    adjustment.approved_at = datetime.now(timezone.utc)

    await write_audit_log(
        db,
        actor_id=admin.id,
        action="settlement.adjust_approved",
        resource_type="settlement",
        resource_id=str(settlement_id),
        new_value={
            "adjustment_id": str(adjustment_id),
            "amount": float(adjustment.amount),
            "created_by": str(adjustment.created_by) if adjustment.created_by else None,
            "new_net_payout": float(new_net),
        },
    )
    await db.commit()

    return {
        "adjustment_id": str(adjustment_id),
        "settlement_id": str(settlement_id),
        "status": "applied",
        "amount": float(adjustment.amount),
        "new_net_payout": float(new_net),
    }
