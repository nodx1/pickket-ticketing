"""P2-14: Moderation API — admin-only content moderation queue.

Endpoints:
  GET   /api/v1/admin/moderation/queue  — list pending items
  PATCH /api/v1/admin/moderation/{id}   — approve / reject
"""

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.errors import client_error_detail
from app.middleware.auth import get_current_admin
from app.models.moderation import ModerationQueue, ModerationStatus, ModerationContentType
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────


class ModerationItemResponse(BaseModel):
    id: uuid.UUID
    content_type: str
    content_id: uuid.UUID
    content_text: str
    author_id: uuid.UUID
    flag_reason: str
    flag_confidence: float
    flag_action: str
    status: str
    reviewer_id: uuid.UUID | None = None
    reviewer_note: str | None = None
    created_at: datetime
    reviewed_at: datetime | None = None

    model_config = {"from_attributes": True}


class ModerationQueueResponse(BaseModel):
    items: list[ModerationItemResponse]
    total: int
    page: int
    page_size: int


class ModerationDecision(BaseModel):
    action: str = Field(..., pattern="^(approved|rejected)$", description="approved or rejected")
    note: str | None = Field(None, max_length=500, description="Reviewer note")


class ModerationDecisionResponse(BaseModel):
    id: uuid.UUID
    status: str
    reviewer_id: uuid.UUID
    reviewed_at: datetime


# ── Endpoints ─────────────────────────────────────────────────


@router.get(
    "/admin/moderation/queue",
    response_model=ModerationQueueResponse,
    summary="관리자 — 모더레이션 대기열 조회",
)
async def get_moderation_queue(
    status: ModerationStatus | None = Query(None, description="Filter by status"),
    content_type: ModerationContentType | None = Query(None, description="Filter by content type"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
) -> ModerationQueueResponse:
    """List moderation queue items. Defaults to pending if no status filter."""
    query = select(ModerationQueue)
    count_query = select(func.count(ModerationQueue.id))

    # Default to pending
    filter_status = status or ModerationStatus.PENDING
    query = query.where(ModerationQueue.status == filter_status)
    count_query = count_query.where(ModerationQueue.status == filter_status)

    if content_type:
        query = query.where(ModerationQueue.content_type == content_type)
        count_query = count_query.where(ModerationQueue.content_type == content_type)

    query = query.order_by(ModerationQueue.created_at.desc())
    query = query.offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(query)
    items = list(result.scalars().all())

    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    return ModerationQueueResponse(
        items=[ModerationItemResponse.model_validate(item) for item in items],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.patch(
    "/admin/moderation/{item_id}",
    response_model=ModerationDecisionResponse,
    summary="관리자 — 모더레이션 항목 승인/거부",
)
async def review_moderation_item(
    item_id: uuid.UUID,
    decision: ModerationDecision,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> ModerationDecisionResponse:
    """Approve or reject a flagged content item."""
    result = await db.execute(
        select(ModerationQueue).where(ModerationQueue.id == item_id)
    )
    item = result.scalar_one_or_none()

    if not item:
        raise HTTPException(
            status_code=404,
            detail=client_error_detail("MODERATION_ITEM_NOT_FOUND", "해당 모더레이션 항목을 찾을 수 없습니다."),
        )

    if item.status != ModerationStatus.PENDING:
        raise HTTPException(
            status_code=400,
            detail=client_error_detail(
                "MODERATION_ALREADY_REVIEWED",
                f"이미 처리된 항목입니다 (상태: {item.status.value}).",
            ),
        )

    now = datetime.now(timezone.utc)
    item.status = ModerationStatus(decision.action)
    item.reviewer_id = admin.id
    item.reviewer_note = decision.note
    item.reviewed_at = now

    await db.commit()
    await db.refresh(item)

    logger.info(
        "Moderation item %s %s by admin %s",
        item_id,
        decision.action,
        admin.id,
    )

    return ModerationDecisionResponse(
        id=item.id,
        status=item.status.value,
        reviewer_id=admin.id,
        reviewed_at=now,
    )
