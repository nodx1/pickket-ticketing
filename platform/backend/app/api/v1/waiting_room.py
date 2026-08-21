import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse

from app.middleware.auth import get_current_user_optional
from app.models.user import User
from app.services.queue_service import QueueService

router = APIRouter()


@router.get("/waiting-room/status/{event_id}")
async def waiting_room_status(
    event_id: uuid.UUID,
    user_id: uuid.UUID | None = Query(None),
    user: User | None = Depends(get_current_user_optional),
):
    """
    Queue status endpoint designed for CDN caching.

    Returns generic queue stats (CDN-cacheable) plus user-specific status if user_id provided.
    CloudFront should cache this with TTL=2s.
    """
    try:
        qs = QueueService(event_id)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Queue service temporarily unavailable",
        ) from exc

    if user_id:
        if not user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required for user-specific queue status",
            )
        if str(user.id) != str(user_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You can only query your own queue status",
            )
        queue_status = await qs.get_status(user_id)
        data = {
            "position": queue_status.position,
            "total_waiting": queue_status.total_waiting,
            "is_active": queue_status.is_active,
            "estimated_wait_seconds": queue_status.estimated_wait_seconds,
            "token": queue_status.token,
        }
    else:
        stats = await qs.get_stats()
        data = {
            "queue_length": stats.total_waiting,
            "active_count": stats.active_count,
            "estimated_wait": stats.total_waiting * 3 // stats.max_active
            if stats.total_waiting > 0
            else 0,
        }

    response = JSONResponse(content=data)
    if user_id:
        response.headers["Cache-Control"] = "private, no-cache"
    else:
        response.headers["Cache-Control"] = "public, max-age=2"

    return response
