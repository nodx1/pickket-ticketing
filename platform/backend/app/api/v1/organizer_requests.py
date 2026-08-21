"""Organizer request management API — unified request system."""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer, get_current_admin
from app.models.user import User
from app.models.organizer_request import OrganizerRequest, RequestStatus
from app.schemas.organizer import (
    OrganizerRequestCreate,
    OrganizerRequestUpdate,
    OrganizerRequestResponse,
    OrganizerRequestListResponse,
    RequestReviewAction,
)

router = APIRouter()


@router.post("/", response_model=OrganizerRequestResponse, status_code=201)
async def create_request(
    data: OrganizerRequestCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Create a new organizer request."""
    req = OrganizerRequest(
        organizer_id=user.id,
        event_id=data.event_id,
        request_type=data.request_type,
        title=data.title,
        content=data.content,
        attachments=data.attachments,
        extra_data=data.extra_data,
        status=RequestStatus.DRAFT,
    )
    db.add(req)
    await db.commit()
    await db.refresh(req)
    return OrganizerRequestResponse.model_validate(req)


@router.get("/", response_model=OrganizerRequestListResponse)
async def list_requests(
    request_type: str | None = None,
    status: str | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """List organizer's requests with optional filters."""
    conditions = [OrganizerRequest.organizer_id == user.id]
    if request_type:
        conditions.append(OrganizerRequest.request_type == request_type)
    if status:
        conditions.append(OrganizerRequest.status == status)

    total = (
        await db.execute(select(func.count(OrganizerRequest.id)).where(*conditions))
    ).scalar() or 0

    result = await db.execute(
        select(OrganizerRequest)
        .where(*conditions)
        .order_by(OrganizerRequest.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    requests = result.scalars().all()
    return OrganizerRequestListResponse(
        requests=[OrganizerRequestResponse.model_validate(r) for r in requests],
        total=total,
    )


@router.get("/summary")
async def request_summary(
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """Get request counts grouped by type and status."""
    result = await db.execute(
        select(
            OrganizerRequest.request_type,
            OrganizerRequest.status,
            func.count(OrganizerRequest.id).label("count"),
        )
        .where(OrganizerRequest.organizer_id == user.id)
        .group_by(OrganizerRequest.request_type, OrganizerRequest.status)
    )
    rows = result.all()
    summary = {}
    for rtype, rstatus, count in rows:
        if rtype not in summary:
            summary[rtype] = {}
        summary[rtype][rstatus] = count
    return summary


@router.get("/{request_id}", response_model=OrganizerRequestResponse)
async def get_request(
    request_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Get request detail."""
    result = await db.execute(
        select(OrganizerRequest).where(
            OrganizerRequest.id == request_id,
            OrganizerRequest.organizer_id == user.id,
        )
    )
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    return OrganizerRequestResponse.model_validate(req)


@router.patch("/{request_id}", response_model=OrganizerRequestResponse)
async def update_request(
    request_id: uuid.UUID,
    data: OrganizerRequestUpdate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Update a draft request."""
    result = await db.execute(
        select(OrganizerRequest).where(
            OrganizerRequest.id == request_id,
            OrganizerRequest.organizer_id == user.id,
        )
    )
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    if req.status not in (RequestStatus.DRAFT, RequestStatus.REVISION_REQUESTED):
        raise HTTPException(status_code=400, detail="Cannot edit submitted request")

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(req, field, value)

    await db.commit()
    await db.refresh(req)
    return OrganizerRequestResponse.model_validate(req)


@router.post("/{request_id}/submit", response_model=OrganizerRequestResponse)
async def submit_request(
    request_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Submit a draft request for review."""
    result = await db.execute(
        select(OrganizerRequest).where(
            OrganizerRequest.id == request_id,
            OrganizerRequest.organizer_id == user.id,
        )
    )
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    if req.status not in (RequestStatus.DRAFT, RequestStatus.REVISION_REQUESTED):
        raise HTTPException(status_code=400, detail="Request already submitted")

    req.status = RequestStatus.SUBMITTED
    req.submitted_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(req)
    return OrganizerRequestResponse.model_validate(req)


@router.patch("/admin/requests/{request_id}/review")
async def review_request(
    request_id: uuid.UUID,
    data: RequestReviewAction,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin: review an organizer request."""
    result = await db.execute(select(OrganizerRequest).where(OrganizerRequest.id == request_id))
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")

    action_map = {
        "approve": RequestStatus.APPROVED,
        "reject": RequestStatus.REJECTED,
        "revision_requested": RequestStatus.REVISION_REQUESTED,
    }
    new_status = action_map.get(data.action)
    if not new_status:
        raise HTTPException(status_code=400, detail="Invalid action")

    req.status = new_status
    req.reviewer_id = admin.id
    req.reviewer_comment = data.comment
    req.reviewed_at = datetime.now(timezone.utc)
    await db.commit()
    return {"detail": f"Request {data.action}", "request_id": str(request_id)}
