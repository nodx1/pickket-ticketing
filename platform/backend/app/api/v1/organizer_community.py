"""Organizer-side community management API (reviews, Q&A, template change requests)."""

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer
from app.models.user import User
from app.models.event import Event
from app.models.fanclub import Fanclub, _VALID_EVENT_TYPE_TEMPLATES
from app.models.template_change import TemplateChangeRequest, TemplateChangeStatus
from app.core.audit import write_audit_log

router = APIRouter()


class ReviewItem(BaseModel):
    """Placeholder review schema — expand when review model is created."""

    id: uuid.UUID
    event_id: uuid.UUID
    user_id: uuid.UUID
    content: str
    rating: int | None = None
    is_best: bool = False
    created_at: str


@router.get("/events/{event_id}/reviews")
async def list_reviews(
    event_id: uuid.UUID,
    review_type: str = Query("review", description="review or expectation"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """List reviews/expectations for an organizer's event.

    Note: Returns empty list until Review model is implemented.
    The endpoint structure is ready for domain-adaptive labels.
    """
    event = (
        await db.execute(select(Event).where(Event.id == event_id, Event.organizer_id == user.id))
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # TODO: Query from Review model when implemented
    return []


@router.post("/events/{event_id}/reviews/{review_id}/best")
async def toggle_best_review(
    event_id: uuid.UUID,
    review_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Toggle best review badge."""
    event = (
        await db.execute(select(Event).where(Event.id == event_id, Event.organizer_id == user.id))
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # TODO: Toggle is_best on Review model when implemented
    return {"detail": "Best review toggled", "review_id": str(review_id)}


@router.post("/events/{event_id}/reviews/{review_id}/delete-request")
async def request_review_deletion(
    event_id: uuid.UUID,
    review_id: uuid.UUID,
    reason: str = "other",
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Request deletion of a review (비방/욕설/광고/스팸/기타)."""
    event = (
        await db.execute(select(Event).where(Event.id == event_id, Event.organizer_id == user.id))
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # TODO: Create deletion request when Review model is implemented
    return {"detail": "Deletion requested", "review_id": str(review_id), "reason": reason}


@router.post("/events/{event_id}/qna/{qna_id}/answer")
async def answer_qna(
    event_id: uuid.UUID,
    qna_id: uuid.UUID,
    answer: str,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Answer a Q&A question."""
    event = (
        await db.execute(select(Event).where(Event.id == event_id, Event.organizer_id == user.id))
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # TODO: Update QnA model when implemented
    return {"detail": "Answer registered", "qna_id": str(qna_id)}


# ════════════════════════════════════════════════════════════════════
# Template Change Requests (WP05)
# ════════════════════════════════════════════════════════════════════


class TemplateChangeRequestCreate(BaseModel):
    new_template: str = Field(min_length=1, max_length=50)
    reason: str = Field(min_length=1, max_length=2000)


class TemplateChangeRequestResponse(BaseModel):
    id: uuid.UUID
    fanclub_id: uuid.UUID
    old_template: str | None
    new_template: str
    reason: str
    requested_by: uuid.UUID
    status: str
    reviewed_by: uuid.UUID | None = None
    reviewed_at: datetime | None = None
    rejection_reason: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


@router.post(
    "/communities/{community_id}/template-change-request",
    response_model=TemplateChangeRequestResponse,
    status_code=201,
)
async def request_template_change(
    community_id: uuid.UUID,
    body: TemplateChangeRequestCreate,
    current_user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Request a template change for a community (organizer only).

    The change is not applied immediately; an admin must approve it first.
    """
    # Verify community ownership
    result = await db.execute(
        select(Fanclub).where(
            Fanclub.id == community_id,
            Fanclub.organizer_id == current_user.id,
        )
    )
    fanclub = result.scalar_one_or_none()
    if not fanclub:
        raise HTTPException(status_code=404, detail="커뮤니티를 찾을 수 없습니다.")

    # Validate new template value
    if body.new_template not in _VALID_EVENT_TYPE_TEMPLATES:
        raise HTTPException(
            status_code=400,
            detail=f"유효하지 않은 템플릿입니다. 가능한 값: {sorted(_VALID_EVENT_TYPE_TEMPLATES)}",
        )

    # Check for existing pending request
    existing = await db.execute(
        select(TemplateChangeRequest).where(
            TemplateChangeRequest.fanclub_id == community_id,
            TemplateChangeRequest.status == TemplateChangeStatus.PENDING.value,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=409,
            detail="이미 대기 중인 템플릿 변경 요청이 있습니다.",
        )

    change_request = TemplateChangeRequest(
        fanclub_id=community_id,
        old_template=fanclub.event_type_template,
        new_template=body.new_template,
        reason=body.reason,
        requested_by=current_user.id,
        status=TemplateChangeStatus.PENDING.value,
    )
    db.add(change_request)

    # Audit log (event_id=None for community-level actions) — WP-16 통합
    await write_audit_log(
        db,
        actor_id=current_user.id,
        action="weight_template_change_request",
        resource_type="template_change",
        resource_id=str(change_request.id) if hasattr(change_request, "id") else None,
        new_value={
            "fanclub_id": str(community_id),
            "old_template": fanclub.event_type_template,
            "new_template": body.new_template,
            "reason": body.reason,
            "result": "success",
        },
    )

    await db.commit()
    await db.refresh(change_request)

    return TemplateChangeRequestResponse.model_validate(change_request)


@router.get(
    "/communities/{community_id}/template-change-requests",
    response_model=list[TemplateChangeRequestResponse],
)
async def list_my_template_change_requests(
    community_id: uuid.UUID,
    current_user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """List template change requests for a community (organizer only)."""
    # Verify ownership
    fc_result = await db.execute(
        select(Fanclub).where(
            Fanclub.id == community_id,
            Fanclub.organizer_id == current_user.id,
        )
    )
    if not fc_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="커뮤니티를 찾을 수 없습니다.")

    result = await db.execute(
        select(TemplateChangeRequest)
        .where(TemplateChangeRequest.fanclub_id == community_id)
        .order_by(TemplateChangeRequest.created_at.desc())
    )
    requests = result.scalars().all()
    return [TemplateChangeRequestResponse.model_validate(r) for r in requests]
