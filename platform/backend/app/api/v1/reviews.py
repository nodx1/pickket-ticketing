"""Event review endpoints."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.sanitize import sanitize_html, sanitize_plain_text
from app.middleware.auth import get_current_user
from app.models.review import Review
from app.models.user import User
from app.models.order import Order, OrderStatus
from app.schemas.review import ReviewCreate, ReviewResponse, ReviewSummary

router = APIRouter()


@router.post("/{event_id}/reviews", response_model=ReviewResponse, status_code=201)
async def create_review(
    event_id: uuid.UUID,
    data: ReviewCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a review for an event. Only confirmed order holders can review."""
    # Check if user has a confirmed order for this event
    order_check = await db.execute(
        select(Order.id)
        .where(
            Order.event_id == event_id,
            Order.user_id == user.id,
            Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
        )
        .limit(1)
    )
    has_order = order_check.scalar_one_or_none() is not None

    # Check for duplicate review
    existing = await db.execute(
        select(Review.id)
        .where(
            Review.event_id == event_id,
            Review.user_id == user.id,
        )
        .limit(1)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="이미 리뷰를 작성하셨습니다")

    review = Review(
        user_id=user.id,
        event_id=event_id,
        rating=data.rating,
        title=sanitize_plain_text(data.title),
        content=sanitize_html(data.content),
        is_verified_attendee=has_order,
    )
    db.add(review)
    await db.commit()
    await db.refresh(review)

    # AP 적립: 후기 작성 80AP (사진 포함 시 120AP)
    try:
        from app.services.point_service import PointService
        from app.models.point import PointType, PointTransactionType
        ps = PointService(db)
        ap_amount = 120 if data.content and "<img" in data.content else 80
        await ps.earn(
            user_id=user.id,
            point_type=PointType.FAN,
            amount=ap_amount,
            tx_type=PointTransactionType.EARN_REVIEW,
            reference_id=review.id,
            description=f"후기 작성 ({ap_amount}AP)",
        )
        await db.commit()
    except Exception:
        pass  # AP 지급 실패해도 후기 자체는 성공

    return ReviewResponse(
        id=review.id,
        user_id=review.user_id,
        event_id=review.event_id,
        rating=review.rating,
        title=review.title,
        content=review.content,
        is_verified_attendee=review.is_verified_attendee,
        helpful_count=review.helpful_count,
        reviewer_name=user.name,
        created_at=review.created_at,
    )


@router.get("/{event_id}/reviews", response_model=list[ReviewResponse])
async def get_event_reviews(
    event_id: uuid.UUID,
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=50),
    db: AsyncSession = Depends(get_read_db),
):
    """Get reviews for an event."""
    result = await db.execute(
        select(Review, User.name)
        .join(User, Review.user_id == User.id)
        .where(Review.event_id == event_id, Review.is_hidden == False)  # noqa: E712
        .order_by(Review.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    rows = result.all()

    return [
        ReviewResponse(
            id=review.id,
            user_id=review.user_id,
            event_id=review.event_id,
            rating=review.rating,
            title=review.title,
            content=review.content,
            is_verified_attendee=review.is_verified_attendee,
            helpful_count=review.helpful_count,
            reviewer_name=name,
            created_at=review.created_at,
        )
        for review, name in rows
    ]


@router.get("/{event_id}/reviews/summary", response_model=ReviewSummary)
async def get_review_summary(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_read_db),
):
    """Get review summary (average rating, distribution)."""
    result = await db.execute(
        select(
            func.avg(Review.rating),
            func.count(Review.id),
        ).where(Review.event_id == event_id, Review.is_hidden == False)  # noqa: E712
    )
    row = result.one()
    avg_rating = float(row[0]) if row[0] else 0.0
    total = row[1] or 0

    # Rating distribution
    dist_result = await db.execute(
        select(Review.rating, func.count(Review.id))
        .where(Review.event_id == event_id, Review.is_hidden == False)  # noqa: E712
        .group_by(Review.rating)
    )
    distribution = {i: 0 for i in range(1, 6)}
    for rating, count in dist_result.all():
        distribution[rating] = count

    return ReviewSummary(
        average_rating=round(avg_rating, 1),
        total_reviews=total,
        rating_distribution=distribution,
    )


@router.post("/{event_id}/reviews/{review_id}/helpful")
async def mark_review_helpful(
    event_id: uuid.UUID,
    review_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mark a review as helpful (increment counter)."""
    result = await db.execute(
        select(Review).where(Review.id == review_id, Review.event_id == event_id)
    )
    review = result.scalar_one_or_none()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")

    review.helpful_count += 1
    await db.commit()
    return {"helpful_count": review.helpful_count}


@router.delete("/{event_id}/reviews/{review_id}", status_code=204)
async def delete_review(
    event_id: uuid.UUID,
    review_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete own review."""
    result = await db.execute(
        select(Review).where(
            Review.id == review_id,
            Review.event_id == event_id,
            Review.user_id == user.id,
        )
    )
    review = result.scalar_one_or_none()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")

    await db.delete(review)
    await db.commit()
