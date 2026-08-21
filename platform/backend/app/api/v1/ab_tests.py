"""A/B tests API — full experiment framework (P1-10).

Provides:
- Admin CRUD for experiments
- Public variant assignment for logged-in users
- Conversion event tracking
- Results / analytics per variant
"""

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import (
    get_current_admin,
    get_current_organizer,
    get_current_user,
    get_current_user_optional,
)
from app.models.ab_test import ABTest, ABTestStatus
from app.models.event import Event
from app.models.event_page import EventPage
from app.models.user import User
from app.services.ab_test_service import ABTestService

router = APIRouter()


# ──────── Schemas ────────


class VariantInput(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    weight: int = Field(1, ge=1, le=100)
    config: dict = Field(default_factory=dict)


class TargetAudienceInput(BaseModel):
    percentage: float = Field(100.0, ge=0, le=100)
    user_segments: list[str] = Field(default_factory=list)


class ABTestCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str | None = None
    variants: list[VariantInput] = Field(..., min_length=2, max_length=10)
    event_page_id: uuid.UUID | None = None
    target_audience: TargetAudienceInput | None = None
    metric_key: str | None = None
    start_date: datetime | None = None
    end_date: datetime | None = None


class ABTestUpdate(BaseModel):
    status: ABTestStatus | None = None
    description: str | None = None
    target_audience: TargetAudienceInput | None = None
    metric_key: str | None = None
    start_date: datetime | None = None
    end_date: datetime | None = None


class VariantResponse(BaseModel):
    name: str
    weight: int
    config: dict = {}


class ABTestResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    status: str
    variants: list[VariantResponse]
    target_audience: dict | None
    metric_key: str | None
    event_page_id: uuid.UUID | None
    start_date: datetime | None
    end_date: datetime | None
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class VariantAssignment(BaseModel):
    test_name: str
    test_id: str
    variant_name: str


class TrackEventRequest(BaseModel):
    test_name: str
    event_type: str = Field(..., min_length=1, max_length=100)
    value: float | None = None


class VariantResult(BaseModel):
    name: str
    assignments: int
    impressions: int
    conversions: int
    conversion_rate: float
    avg_value: float | None


class ABTestResults(BaseModel):
    variants: list[VariantResult]
    total_assignments: int


# ──────── Helpers ────────


def _serialize_test(test: ABTest) -> dict:
    return {
        "id": str(test.id),
        "name": test.name,
        "description": test.description,
        "status": test.status.value if test.status else "DRAFT",
        "variants": test.variants or [],
        "target_audience": test.target_audience,
        "metric_key": test.metric_key,
        "event_page_id": str(test.event_page_id) if test.event_page_id else None,
        "start_date": test.start_date.isoformat() if test.start_date else None,
        "end_date": test.end_date.isoformat() if test.end_date else None,
        "created_by": str(test.created_by) if test.created_by else None,
        "created_at": test.created_at.isoformat(),
        "updated_at": test.updated_at.isoformat(),
    }


def _normalize_variants(body: ABTestCreate) -> list[dict]:
    return [
        {"name": v.name, "weight": v.weight, "config": v.config}
        for v in body.variants
    ]


def _normalize_target_audience(body: ABTestCreate) -> dict | None:
    if not body.target_audience:
        return None
    return {
        "percentage": body.target_audience.percentage,
        "user_segments": body.target_audience.user_segments,
    }


async def _create_test_record(
    *,
    body: ABTestCreate,
    created_by: uuid.UUID,
    db: AsyncSession,
    event_page_id: uuid.UUID | None = None,
) -> ABTest:
    existing = await db.execute(select(ABTest).where(ABTest.name == body.name))
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A/B test with this name already exists",
        )

    test = ABTest(
        name=body.name,
        description=body.description,
        status=ABTestStatus.DRAFT,
        variants=_normalize_variants(body),
        target_audience=_normalize_target_audience(body),
        metric_key=body.metric_key,
        event_page_id=event_page_id or body.event_page_id,
        start_date=body.start_date,
        end_date=body.end_date,
        created_by=created_by,
        is_active=True,
    )
    db.add(test)
    await db.commit()
    await db.refresh(test)
    return test


# ──────── Admin CRUD endpoints ────────


@router.post(
    "/ab-tests",
    status_code=status.HTTP_201_CREATED,
    tags=["ab-tests"],
)
async def create_ab_test(
    body: ABTestCreate,
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Create a new A/B test experiment (admin only)."""
    test = await _create_test_record(body=body, created_by=user.id, db=db)
    return _serialize_test(test)


@router.post(
    "/event-pages/{page_id}/ab-tests",
    status_code=status.HTTP_201_CREATED,
    tags=["ab-tests"],
)
async def create_ab_test_for_page(
    page_id: uuid.UUID,
    body: ABTestCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Create an A/B test for an organizer-owned event page."""
    page_result = await db.execute(
        select(EventPage)
        .join(Event, EventPage.event_id == Event.id)
        .where(EventPage.id == page_id, Event.organizer_id == user.id)
    )
    page = page_result.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")

    test = await _create_test_record(
        body=body,
        created_by=user.id,
        db=db,
        event_page_id=page.id,
    )
    return _serialize_test(test)


@router.get("/ab-tests", tags=["ab-tests"])
async def list_ab_tests(
    status_filter: ABTestStatus | None = Query(None, alias="status"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """List all A/B tests (admin only)."""
    query = select(ABTest).order_by(ABTest.created_at.desc())
    if status_filter:
        query = query.where(ABTest.status == status_filter)
    query = query.offset(skip).limit(limit)

    result = await db.execute(query)
    tests = result.scalars().all()
    return {
        "items": [_serialize_test(t) for t in tests],
        "total": len(tests),
    }


# ──────── Public endpoints (MUST be before {test_id} path param routes) ──────


@router.get("/ab-tests/variant", tags=["ab-tests"])
async def get_variant_for_user(
    test_name: str = Query(..., min_length=1),
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Get the assigned variant for the current user (public).

    Returns the variant assignment or null if user is not logged in or test is inactive.
    """
    if not user:
        return None

    service = ABTestService(db)
    result = await service.get_variant(test_name, user.id)
    if not result:
        return None

    return result


@router.post("/ab-tests/track", tags=["ab-tests"])
async def track_conversion_event(
    body: TrackEventRequest,
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Track a conversion/impression event for the current user."""
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required for tracking",
        )

    service = ABTestService(db)
    tracked = await service.track_event(
        test_name=body.test_name,
        user_id=user.id,
        event_type=body.event_type,
        value=body.value,
    )
    if not tracked:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Test not found or user not assigned",
        )

    return {"ok": True}


# ──────── Admin detail endpoints (path param {test_id}) ────────


@router.get("/ab-tests/{test_id}", tags=["ab-tests"])
async def get_ab_test(
    test_id: uuid.UUID,
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """Get A/B test detail with results (admin only)."""
    result = await db.execute(select(ABTest).where(ABTest.id == test_id))
    test = result.scalar_one_or_none()
    if not test:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="A/B test not found"
        )

    service = ABTestService(db)
    results = await service.get_results(test_id)

    return {
        **_serialize_test(test),
        "results": results,
    }


@router.patch("/ab-tests/{test_id}", tags=["ab-tests"])
async def update_ab_test(
    test_id: uuid.UUID,
    body: ABTestUpdate,
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Update an A/B test (status, description, etc.) — admin only."""
    result = await db.execute(select(ABTest).where(ABTest.id == test_id))
    test = result.scalar_one_or_none()
    if not test:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="A/B test not found"
        )

    if body.status is not None:
        test.status = body.status
        # Sync legacy is_active
        test.is_active = body.status == ABTestStatus.RUNNING

    if body.description is not None:
        test.description = body.description

    if body.target_audience is not None:
        test.target_audience = {
            "percentage": body.target_audience.percentage,
            "user_segments": body.target_audience.user_segments,
        }

    if body.metric_key is not None:
        test.metric_key = body.metric_key

    if body.start_date is not None:
        test.start_date = body.start_date

    if body.end_date is not None:
        test.end_date = body.end_date

    await db.commit()
    await db.refresh(test)
    return _serialize_test(test)


# ──────── Legacy event-page-scoped endpoints (backward compat) ────────


@router.get("/event-pages/{page_id}/ab-tests", tags=["ab-tests"])
async def list_ab_tests_for_page(
    page_id: uuid.UUID,
    db: AsyncSession = Depends(get_read_db),
):
    """List A/B tests for an event page (public, SSR-compatible)."""
    result = await db.execute(
        select(ABTest)
        .where(ABTest.event_page_id == page_id)
        .order_by(ABTest.created_at.desc())
    )
    tests = result.scalars().all()
    return {
        "items": [_serialize_test(t) for t in tests],
        "total": len(tests),
    }
