"""Shared FastAPI dependencies for v1 endpoints."""

from __future__ import annotations

import logging

from fastapi import HTTPException, Request

from app.core.config import settings
from app.services.bot_detection_service import BotDetectionService

logger = logging.getLogger(__name__)


async def verify_behavior_token(request: Request) -> None:
    """Extract and verify the X-Behavior-Token header.

    Raises 403 if the token is missing or invalid.
    Raises 503 if Redis is unavailable (FAIL-CLOSED — never skip verification).

    Only skips verification when BOT_DETECTION_KEY is not configured (dev/test).
    """
    if not settings.BOT_DETECTION_KEY:
        # Bot detection not configured — skip verification (dev/test only)
        return

    token = request.headers.get("x-behavior-token")
    session_id = request.headers.get("x-behavior-session")

    if not token or not session_id:
        raise HTTPException(
            status_code=403,
            detail="Missing behavior verification token",
        )

    service = BotDetectionService()
    try:
        valid = await service.verify_token(token, session_id)
    except RuntimeError:
        # Redis unavailable — FAIL CLOSED: block the request
        logger.error("Bot detection verify_token failed (Redis unavailable), BLOCKING request")
        raise HTTPException(
            status_code=503,
            detail="Security verification service temporarily unavailable. Please try again.",
        )

    if not valid:
        raise HTTPException(
            status_code=403,
            detail="Invalid behavior verification token",
        )
