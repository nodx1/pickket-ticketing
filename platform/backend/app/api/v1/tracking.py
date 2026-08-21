"""Behavior tracking API — P1-5.

POST /api/v1/track — batch endpoint accepting up to 50 events per request.
Supports both authenticated and anonymous (session_id cookie) callers.
GDPR: requires X-Tracking-Consent: true header.
Inserts are performed in a background task so the response is not blocked.
"""

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.middleware.auth import get_current_user_optional
from app.models.user import User
from app.models.user_behavior import UserBehavior
from app.schemas.tracking import TrackingBatchRequest, TrackingBatchResponse

logger = logging.getLogger(__name__)

router = APIRouter()

SESSION_COOKIE = "pickket_session_id"
ALLOWED_EVENT_TYPES = {
    "page_view", "event_view", "search", "bid",
    "purchase", "share", "favorite", "click",
}
ALLOWED_TARGET_TYPES = {
    "event", "tier", "artist", "category", None,
}


def _get_or_create_session_id(request: Request, response: Response) -> str:
    """Return existing session cookie or generate a new one and set it."""
    session_id = request.cookies.get(SESSION_COOKIE)
    if not session_id:
        session_id = uuid.uuid4().hex
        response.set_cookie(
            SESSION_COOKIE,
            session_id,
            max_age=60 * 60 * 24 * 365,  # 1 year
            httponly=True,
            samesite="lax",
            secure=request.url.scheme == "https",
        )
    return session_id


@router.post(
    "/track",
    response_model=TrackingBatchResponse,
    status_code=202,
    summary="Batch behavior tracking",
)
async def track_events(
    body: TrackingBatchRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user_optional),
):
    # ── GDPR consent check ──────────────────────────────────────────────
    consent = request.headers.get("X-Tracking-Consent", "").lower()
    if consent != "true":
        return TrackingBatchResponse(accepted=0, message="no_consent")

    session_id = _get_or_create_session_id(request, response)
    user_id = user.id if user else None
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    accepted = 0
    for evt in body.events:
        # Validate event_type
        if evt.event_type not in ALLOWED_EVENT_TYPES:
            continue
        if evt.target_type not in ALLOWED_TARGET_TYPES:
            continue

        row = UserBehavior(
            user_id=user_id,
            session_id=session_id,
            event_type=evt.event_type,
            target_type=evt.target_type,
            target_id=evt.target_id,
            metadata_json=evt.metadata,
            created_at=now,
        )
        db.add(row)
        accepted += 1

    if accepted > 0:
        try:
            await db.commit()
        except Exception:
            logger.exception("Failed to persist behavior tracking batch")
            await db.rollback()
            return TrackingBatchResponse(accepted=0, message="persist_error")

        # AP 적립: share 이벤트 시 20AP (이벤트당 1회)
        if user_id:
            share_events = [e for e in body.events if e.event_type == "share" and e.target_id]
            for se in share_events:
                try:
                    from app.services.point_service import PointService
                    from app.models.point import PointType, PointTransactionType, PointTransaction
                    ps = PointService(db)
                    # 중복 체크: 같은 이벤트 공유 AP 이미 받았는지
                    dup = await db.execute(
                        select(PointTransaction.id).where(
                            PointTransaction.user_id == user_id,
                            PointTransaction.tx_type == PointTransactionType.EARN_SHARE,
                            PointTransaction.reference_id == uuid.UUID(se.target_id),
                        ).limit(1)
                    )
                    if not dup.scalar_one_or_none():
                        await ps.earn(
                            user_id=user_id,
                            point_type=PointType.FAN,
                            amount=20,
                            tx_type=PointTransactionType.EARN_SHARE,
                            reference_id=uuid.UUID(se.target_id),
                            description="SNS 공유 (20AP)",
                        )
                        await db.commit()
                except Exception:
                    pass

    return TrackingBatchResponse(accepted=accepted)
