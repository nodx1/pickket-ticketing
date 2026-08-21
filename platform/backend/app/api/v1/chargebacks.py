"""Chargeback 관리 API — P2-11 관리자 차지백 처리.

GET  /api/v1/admin/chargebacks          — 차지백 목록 조회
PATCH /api/v1/admin/chargebacks/{id}    — 상태 업데이트, 증빙 추가
POST /api/v1/admin/chargebacks/{id}/dispute — 차지백 분쟁 제기
"""

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.audit import write_audit_log
from app.middleware.auth import get_current_admin
from app.models.chargeback import Chargeback, ChargebackStatus
from app.models.user import User
from app.services.chargeback_service import (
    ChargebackResolutionError,
    apply_chargeback_resolution,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────


class ChargebackResponse(BaseModel):
    id: uuid.UUID
    order_id: uuid.UUID
    payment_id: str
    pg_chargeback_id: str | None = None
    amount: float
    currency: str
    reason: str
    reason_code: str | None = None
    status: str
    evidence: dict | None = None
    evidence_deadline: datetime | None = None
    dispute_notes: str | None = None
    assigned_to: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    resolved_at: datetime | None = None

    model_config = {"from_attributes": True}


class ChargebackListResponse(BaseModel):
    items: list[ChargebackResponse]
    total: int
    skip: int
    limit: int


class ChargebackUpdateRequest(BaseModel):
    status: str | None = None
    evidence: dict | None = None
    dispute_notes: str | None = None
    assigned_to: uuid.UUID | None = None


class ChargebackDisputeRequest(BaseModel):
    evidence: dict = Field(..., description="증빙 자료 (파일 URL, 텍스트 등)")
    notes: str = Field(..., min_length=1, max_length=2000)


class ChargebackCreateRequest(BaseModel):
    order_id: uuid.UUID
    payment_id: str
    amount: float = Field(..., gt=0)
    reason: str = Field(..., min_length=1, max_length=1000)
    reason_code: str | None = None
    pg_chargeback_id: str | None = None
    evidence_deadline: datetime | None = None


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get("/admin/chargebacks", response_model=ChargebackListResponse)
async def list_chargebacks(
    status: str | None = Query(None, description="필터: 차지백 상태"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """차지백 목록 조회 (admin only)."""
    stmt = select(Chargeback)
    count_stmt = select(func.count(Chargeback.id))

    if status:
        stmt = stmt.where(Chargeback.status == status)
        count_stmt = count_stmt.where(Chargeback.status == status)

    total_result = await db.execute(count_stmt)
    total = total_result.scalar() or 0

    stmt = stmt.order_by(Chargeback.created_at.desc()).offset(skip).limit(limit)
    result = await db.execute(stmt)
    chargebacks = list(result.scalars().all())

    return ChargebackListResponse(
        items=[ChargebackResponse.model_validate(cb) for cb in chargebacks],
        total=total,
        skip=skip,
        limit=limit,
    )


@router.post("/admin/chargebacks", response_model=ChargebackResponse, status_code=201)
async def create_chargeback(
    body: ChargebackCreateRequest,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """차지백 수동 등록 (PG 웹훅 또는 수동 입력)."""
    chargeback = Chargeback(
        order_id=body.order_id,
        payment_id=body.payment_id,
        pg_chargeback_id=body.pg_chargeback_id,
        amount=body.amount,
        reason=body.reason,
        reason_code=body.reason_code,
        evidence_deadline=body.evidence_deadline,
        status=ChargebackStatus.RECEIVED,
    )
    db.add(chargeback)
    await db.flush()

    await write_audit_log(
        db,
        actor_id=admin.id,
        action="chargeback.created",
        resource_type="chargeback",
        resource_id=str(chargeback.id),
        new_value={
            "order_id": str(body.order_id),
            "amount": body.amount,
            "reason": body.reason[:200],
        },
    )

    await db.commit()
    await db.refresh(chargeback)
    return ChargebackResponse.model_validate(chargeback)


@router.patch("/admin/chargebacks/{chargeback_id}", response_model=ChargebackResponse)
async def update_chargeback(
    chargeback_id: uuid.UUID,
    body: ChargebackUpdateRequest,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """차지백 상태 업데이트, 증빙 추가."""
    result = await db.execute(
        select(Chargeback).where(Chargeback.id == chargeback_id).with_for_update()
    )
    chargeback = result.scalar_one_or_none()
    if not chargeback:
        raise HTTPException(status_code=404, detail="Chargeback not found")

    old_status = chargeback.status
    updates = {}

    if body.status is not None:
        # 유효한 상태 전이 검증
        valid_transitions = {
            "received": {"under_review", "accepted"},
            "under_review": {"accepted", "disputed"},
            "disputed": {"won", "lost"},
        }
        allowed = valid_transitions.get(chargeback.status, set())
        if body.status not in allowed:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status transition: {chargeback.status} → {body.status}",
            )
        chargeback.status = body.status
        updates["status"] = body.status

        if body.status in ("accepted", "won", "lost"):
            chargeback.resolved_at = datetime.now(timezone.utc)

        # accepted/lost = 환불 확정 — 환불 기록·티켓 회수·원장 반영(정산 클로백 연동).
        # 실패 시 raise → 상태 전이 전체 롤백 (부분 반영 방지).
        if body.status in ("accepted", "lost"):
            try:
                resolution = await apply_chargeback_resolution(
                    db, chargeback, actor_id=admin.id
                )
            except ChargebackResolutionError as e:
                logger.error(
                    "chargeback 재무 반영 실패: chargeback=%s err=%s", chargeback_id, e
                )
                raise HTTPException(status_code=409, detail=str(e)) from e
            updates["resolution"] = resolution

    if body.evidence is not None:
        chargeback.evidence = body.evidence
        updates["evidence_updated"] = True

    if body.dispute_notes is not None:
        chargeback.dispute_notes = body.dispute_notes
        updates["dispute_notes_updated"] = True

    if body.assigned_to is not None:
        chargeback.assigned_to = body.assigned_to
        updates["assigned_to"] = str(body.assigned_to)

    chargeback.updated_at = datetime.now(timezone.utc)

    await write_audit_log(
        db,
        actor_id=admin.id,
        action="chargeback.updated",
        resource_type="chargeback",
        resource_id=str(chargeback_id),
        old_value={"status": old_status},
        new_value=updates,
    )

    await db.commit()
    await db.refresh(chargeback)
    return ChargebackResponse.model_validate(chargeback)


@router.post(
    "/admin/chargebacks/{chargeback_id}/dispute",
    response_model=ChargebackResponse,
)
async def dispute_chargeback(
    chargeback_id: uuid.UUID,
    body: ChargebackDisputeRequest,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """차지백에 대해 분쟁(이의제기) 제기."""
    result = await db.execute(
        select(Chargeback).where(Chargeback.id == chargeback_id).with_for_update()
    )
    chargeback = result.scalar_one_or_none()
    if not chargeback:
        raise HTTPException(status_code=404, detail="Chargeback not found")

    if chargeback.status not in (
        ChargebackStatus.RECEIVED,
        ChargebackStatus.UNDER_REVIEW,
    ):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot dispute chargeback in status '{chargeback.status}'",
        )

    # 증빙 기한 검증
    if chargeback.evidence_deadline:
        now = datetime.now(timezone.utc)
        if now > chargeback.evidence_deadline:
            raise HTTPException(
                status_code=400,
                detail="증빙 제출 기한이 지났습니다",
            )

    old_status = chargeback.status
    chargeback.status = ChargebackStatus.DISPUTED
    chargeback.evidence = body.evidence
    chargeback.dispute_notes = body.notes
    chargeback.updated_at = datetime.now(timezone.utc)

    await write_audit_log(
        db,
        actor_id=admin.id,
        action="chargeback.disputed",
        resource_type="chargeback",
        resource_id=str(chargeback_id),
        old_value={"status": old_status},
        new_value={
            "status": ChargebackStatus.DISPUTED,
            "evidence_submitted": True,
            "notes_length": len(body.notes),
        },
    )

    await db.commit()
    await db.refresh(chargeback)
    return ChargebackResponse.model_validate(chargeback)
